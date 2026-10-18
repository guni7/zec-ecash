//! FROST (RedPallas) helpers shared by the coordinator (zec-processor) and the guardians.
//!
//! Orchard/Ironwood spends are authorized under `rk = ak + [alpha]G`, where `ak` is the FROST
//! group key and `alpha` is the per-spend randomizer chosen when the PCZT is built. So every
//! signature here is *rerandomized FROST* with the randomizer fixed to that spend's `alpha`
//! (not a fresh one: a fresh randomizer gives a key that doesn't match `rk`). Values cross
//! crate and process boundaries as bytes: `alpha` and `rk` as 32-byte Pallas encodings,
//! signatures as 64-byte RedPallas `R || s`.
pub use reddsa::frost::redpallas;

pub mod wire;

use std::collections::BTreeMap;

use anyhow::{Context, Result, anyhow};
use redpallas::{
    Identifier, PallasBlake2b512, SigningPackage,
    keys::{KeyPackage, PublicKeyPackage},
    rerandomized::{RandomizedParams, Randomizer},
    round1::SigningNonces,
    round2::SignatureShare,
};

/// Group size and threshold of the mint's guardians.
pub const MAX_SIGNERS: u16 = 3;
pub const MIN_SIGNERS: u16 = 2;

fn randomizer(alpha: &[u8; 32]) -> Result<Randomizer> {
    Randomizer::deserialize(alpha).map_err(|e| anyhow!("alpha is not a valid Pallas scalar: {e}"))
}

/// Rerandomization parameters for the spend whose randomizer is `alpha`.
pub fn randomized_params(pubkeys: &PublicKeyPackage, alpha: &[u8; 32]) -> Result<RandomizedParams> {
    Ok(RandomizedParams::from_randomizer(pubkeys.verifying_key(), randomizer(alpha)?))
}

/// The key a signature under `alpha` verifies against: `ak + [alpha]G`. Equal to the spend's `rk`
/// when `ak` is this group's key.
pub fn randomized_key(pubkeys: &PublicKeyPackage, alpha: &[u8; 32]) -> Result<[u8; 32]> {
    randomized_params(pubkeys, alpha)?
        .randomized_verifying_key()
        .serialize()
        .map_err(|e| anyhow!("{e}"))?
        .try_into()
        .map_err(|_| anyhow!("verifying key is not 32 bytes"))
}

/// Round 2 for one spend: this guardian's share, with its key package randomized by `alpha`.
///
/// `frost_rerandomized::sign` is the only public entry point that takes an explicit randomizer
/// (the `Randomize` trait behind `key_package.randomize(..)` is private in 3.0.0). It is marked
/// deprecated in favour of `sign_with_randomizer_seed`, which derives a *fresh* randomizer from a
/// seed; that cannot work here because `alpha` is fixed by the transaction.
#[allow(deprecated)]
pub fn sign_share(
    signing_package: &SigningPackage,
    nonces: &SigningNonces,
    key_package: &KeyPackage,
    alpha: &[u8; 32],
) -> Result<SignatureShare> {
    frost_rerandomized::sign::<PallasBlake2b512>(signing_package, nonces, key_package, randomizer(alpha)?)
        .map_err(|e| anyhow!("signing failed: {e}"))
}

/// Aggregates the shares for one spend and checks the result against `ak + [alpha]G` before
/// returning the 64-byte RedPallas signature.
pub fn aggregate(
    signing_package: &SigningPackage,
    shares: &BTreeMap<Identifier, SignatureShare>,
    pubkeys: &PublicKeyPackage,
    alpha: &[u8; 32],
) -> Result<[u8; 64]> {
    let params = randomized_params(pubkeys, alpha)?;
    let sig = redpallas::rerandomized::aggregate(signing_package, shares, pubkeys, &params)
        .map_err(|e| anyhow!("aggregation failed: {e}"))?;
    params
        .randomized_verifying_key()
        .verify(signing_package.message(), &sig)
        .map_err(|e| anyhow!("aggregated signature does not verify: {e}"))?;
    sig.serialize()
        .map_err(|e| anyhow!("{e}"))?
        .try_into()
        .map_err(|_| anyhow!("signature is not 64 bytes"))
}

/// The group key (Orchard `ak`) as 32 bytes. Even-y is guaranteed by reddsa's dealer and DKG.
pub fn group_key_bytes(pubkeys: &PublicKeyPackage) -> Result<[u8; 32]> {
    pubkeys
        .verifying_key()
        .serialize()
        .context("group key")?
        .try_into()
        .map_err(|_| anyhow!("group key is not 32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use redpallas as frost;

    fn dealer() -> (BTreeMap<Identifier, KeyPackage>, PublicKeyPackage) {
        let mut rng = rand::thread_rng();
        let (shares, pubkeys) =
            frost::keys::generate_with_dealer(MAX_SIGNERS, MIN_SIGNERS, frost::keys::IdentifierList::Default, &mut rng)
                .unwrap();
        let kps = shares.into_iter().map(|(id, s)| (id, KeyPackage::try_from(s).unwrap())).collect();
        (kps, pubkeys)
    }

    /// A uniformly random Pallas scalar, like the `alpha` a PCZT builder picks.
    fn random_alpha() -> [u8; 32] {
        frost::SigningKey::new(&mut rand::thread_rng()).serialize().try_into().unwrap()
    }

    /// Runs both rounds with `signers`, signing under `sign_alpha`.
    fn sign(
        kps: &BTreeMap<Identifier, KeyPackage>,
        pubkeys: &PublicKeyPackage,
        signers: &[Identifier],
        sign_alpha: &[u8; 32],
        msg: &[u8],
    ) -> Result<[u8; 64]> {
        let mut rng = rand::thread_rng();
        let mut nonces = BTreeMap::new();
        let mut commitments = BTreeMap::new();
        for id in signers {
            let (n, c) = frost::round1::commit(kps[id].signing_share(), &mut rng);
            nonces.insert(*id, n);
            commitments.insert(*id, c);
        }
        let package = SigningPackage::new(commitments, msg);
        let mut shares = BTreeMap::new();
        for id in signers {
            shares.insert(*id, sign_share(&package, &nonces[id], &kps[id], sign_alpha)?);
        }
        aggregate(&package, &shares, pubkeys, sign_alpha)
    }

    #[test]
    fn any_two_of_three_sign_one_cannot() {
        let (kps, pubkeys) = dealer();
        let ids: Vec<_> = kps.keys().copied().collect();
        let alpha = random_alpha();
        let msg = b"sighash";
        for pair in [[ids[0], ids[1]], [ids[0], ids[2]], [ids[1], ids[2]]] {
            assert!(sign(&kps, &pubkeys, &pair, &alpha, msg).is_ok(), "{pair:?}");
        }
        assert!(sign(&kps, &pubkeys, &ids[..1], &alpha, msg).is_err(), "one guardian alone");
    }

    #[test]
    fn alpha_randomizer_verifies_and_a_fresh_one_does_not() {
        let (kps, pubkeys) = dealer();
        let ids: Vec<_> = kps.keys().copied().take(2).collect();
        let alpha = random_alpha();
        let msg = b"sighash";
        let rk = randomized_key(&pubkeys, &alpha).unwrap();
        let rk = frost::VerifyingKey::deserialize(&rk).unwrap();

        // Signed under alpha: verifies against rk = ak + [alpha]G.
        let sig = sign(&kps, &pubkeys, &ids, &alpha, msg).unwrap();
        assert!(rk.verify(msg, &frost::Signature::deserialize(&sig).unwrap()).is_ok());

        // Signed under a fresh randomizer: valid for its own key, but not for this spend's rk.
        let other = random_alpha();
        let sig = sign(&kps, &pubkeys, &ids, &other, msg).unwrap();
        assert!(rk.verify(msg, &frost::Signature::deserialize(&sig).unwrap()).is_err());
    }

    #[test]
    fn group_key_is_even_y() {
        for _ in 0..8 {
            let (_, pubkeys) = dealer();
            let ak = group_key_bytes(&pubkeys).unwrap();
            assert_eq!(ak[31] & 0x80, 0, "Orchard ak must have ỹ = 0");
        }
    }
}
