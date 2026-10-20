//! PCZT and key plumbing for threshold (FROST) spend authorization. The FROST maths itself is
//! in the `zec-frost` crate; this module only reads and writes PCZTs and Orchard keys.
use std::convert::Infallible;

use anyhow::{Context, Result, anyhow};
use pasta_curves::group::ff::PrimeField;
use rand::{RngCore, rngs::OsRng};
use zcash_keys::keys::UnifiedFullViewingKey;

use crate::Pczt;

/// Which bundle a spend is in; both use Orchard keys and the Orchard signature scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Pool {
    Orchard,
    Ironwood,
}

/// A spend that needs a spend authorization signature, with what a FROST signer needs:
/// the randomizer `alpha` and the randomized key `rk = ak + [alpha]G` it must verify against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendToSign {
    pub pool: Pool,
    pub index: usize,
    pub alpha: [u8; 32],
    pub rk: [u8; 32],
}

/// Every action not yet signed that carries `alpha`: real spends and the wallet-controlled
/// zero-value spends paired with change, but not the builder's pre-signed padding dummies.
/// `alpha` is only visible on the parsed bundles, so this reads them through the Verifier.
pub fn spends_to_sign(pczt: &Pczt) -> Result<Vec<SpendToSign>> {
    fn collect(pool: Pool, bundle: &orchard::pczt::Bundle, out: &mut Vec<SpendToSign>) {
        for (index, action) in bundle.actions().iter().enumerate() {
            let spend = action.spend();
            if spend.spend_auth_sig().is_some() {
                continue;
            }
            if let Some(alpha) = spend.alpha() {
                out.push(SpendToSign {
                    pool,
                    index,
                    alpha: alpha.to_repr(),
                    rk: <[u8; 32]>::from(spend.rk()),
                });
            }
        }
    }
    let mut out = vec![];
    pczt::roles::verifier::Verifier::new(pczt.clone())
        .with_orchard::<Infallible, _>(|b| {
            collect(Pool::Orchard, b, &mut out);
            Ok(())
        })
        .map_err(|e| anyhow!("invalid Orchard bundle: {e:?}"))?
        .with_ironwood::<Infallible, _>(|b| {
            collect(Pool::Ironwood, b, &mut out);
            Ok(())
        })
        .map_err(|e| anyhow!("invalid Ironwood bundle: {e:?}"))?;
    Ok(out)
}

/// The shielded signature hash every spend authorization signs.
pub fn shielded_sighash(pczt: &Pczt) -> Result<[u8; 32]> {
    Ok(pczt::roles::signer::Signer::new(pczt.clone())
        .map_err(|e| anyhow!("PCZT not signable: {e:?}"))?
        .shielded_sighash())
}

/// Applies externally produced (e.g. FROST-aggregated) signatures. Each is verified against the
/// spend's `rk` by the pczt Signer role, so a wrong signature is an error, never applied.
pub fn apply_spend_auth_signatures(pczt: Pczt, sigs: &[(Pool, usize, [u8; 64])]) -> Result<Pczt> {
    let mut signer =
        pczt::roles::signer::Signer::new(pczt).map_err(|e| anyhow!("PCZT not signable: {e:?}"))?;
    for &(pool, index, bytes) in sigs {
        let sig = orchard::primitives::redpallas::Signature::<orchard::primitives::redpallas::SpendAuth>::from(bytes);
        match pool {
            Pool::Orchard => signer.apply_orchard_signature(index, sig),
            Pool::Ironwood => signer.apply_ironwood_signature(index, sig),
        }
        .map_err(|e| anyhow!("{e:?}"))
        .with_context(|| format!("signature for {pool:?} action {index} rejected"))?;
    }
    Ok(signer.finish())
}

/// A UFVK whose Orchard spend validating key `ak` is the FROST group key: `ak || nk || rivk`
/// with fresh random `nk` and `rivk` (retried until they are valid encodings). The FVK parser
/// validates `ak` (non-identity, ỹ = 0), so an odd-y group key is rejected here.
pub fn frost_ufvk(group_key: [u8; 32]) -> Result<UnifiedFullViewingKey> {
    for _ in 0..1000 {
        let mut bytes = [0u8; 96];
        bytes[..32].copy_from_slice(&group_key);
        OsRng.fill_bytes(&mut bytes[32..]);
        if let Some(fvk) = orchard::keys::FullViewingKey::from_bytes(&bytes) {
            return UnifiedFullViewingKey::from_orchard_fvk(fvk).map_err(|e| anyhow!("{e:?}"));
        }
    }
    // Random nk/rivk are valid with probability ~1/4, so 1000 failures means ak itself is bad.
    anyhow::bail!("group key is not a valid Orchard ak (identity or odd y)")
}

/// The Orchard `ak` of a UFVK (what guardians compare with their group key).
pub fn ufvk_ak(ufvk: &UnifiedFullViewingKey) -> Result<[u8; 32]> {
    let fvk = ufvk.orchard().context("UFVK has no Orchard key")?;
    Ok(fvk.to_bytes()[..32].try_into().expect("32 bytes"))
}

/// The Orchard-format receiver (raw 43 bytes) of a withdrawal address, after the same validation
/// the processor applies (a unified address of the current network with an Orchard receiver).
pub fn orchard_receiver(addr: &str) -> Result<[u8; 43]> {
    match crate::validate_withdrawal_address(addr)? {
        zcash_keys::address::Address::Unified(ua) => {
            Ok(ua.orchard().context("no Orchard receiver")?.to_raw_address_bytes())
        }
        _ => anyhow::bail!("not a unified address"),
    }
}

/// Reads a UFVK file (as written by `zec-processor make-ufvk`).
pub fn read_ufvk(path: &std::path::Path) -> Result<UnifiedFullViewingKey> {
    let s = std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    UnifiedFullViewingKey::decode(&crate::network::params(), s.trim())
        .map_err(|e| anyhow!("{}: not a {} UFVK: {e}", path.display(), crate::network::current().label()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zec_frost::redpallas as frost;

    fn group_key() -> [u8; 32] {
        let (_, pubkeys) = frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, rand::thread_rng())
            .unwrap();
        zec_frost::group_key_bytes(&pubkeys).unwrap()
    }

    #[test]
    fn ufvk_round_trip_keeps_the_group_key() {
        let params = crate::regtest::regtest_network();
        let ak = group_key();
        let ufvk = frost_ufvk(ak).unwrap();
        let encoded = ufvk.encode(&params);
        assert!(encoded.starts_with("uviewregtest1"), "{encoded}");
        let decoded = UnifiedFullViewingKey::decode(&params, &encoded).unwrap();
        assert_eq!(ufvk_ak(&decoded).unwrap(), ak);
        assert_eq!(decoded.encode(&params), encoded);
        // Two UFVKs for the same group key differ only in nk/rivk (fresh each time).
        assert_ne!(frost_ufvk(ak).unwrap().encode(&params), encoded);
    }

    #[test]
    fn odd_y_group_key_is_rejected() {
        let mut ak = group_key();
        ak[31] |= 0x80; // set the sign bit: not a valid Orchard ak encoding
        assert!(frost_ufvk(ak).is_err());
    }
}
