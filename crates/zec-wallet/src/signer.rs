//! Who authorizes spends from a wallet. Phase 2 signs with the single mint key
//! ([`LocalSigner`]); Phase 4 adds a 2-of-3 FROST signer behind the same trait.
use std::{convert::Infallible, path::Path};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;

/// Adds spend authorization signatures to a PCZT. `melt_quote_id` identifies the withdrawal
/// being authorized (a FROST signer uses it to coordinate and audit; [`LocalSigner`] ignores it).
#[async_trait]
pub trait Signer: Send + Sync {
    async fn sign(&self, pczt: pczt::Pczt, melt_quote_id: &str) -> Result<pczt::Pczt>;
}

/// Signs with the Orchard spend authorizing key derived from the wallet seed (account 0).
/// The same key authorizes Orchard and Ironwood spends.
pub struct LocalSigner {
    ask: orchard::keys::SpendAuthorizingKey,
}

impl LocalSigner {
    pub fn from_seed_path(seed_path: &Path) -> Result<Self> {
        let seed = crate::read_seed(seed_path)?;
        let usk = crate::spending_key(&seed)?;
        Ok(LocalSigner { ask: orchard::keys::SpendAuthorizingKey::from(usk.orchard()) })
    }
}

/// Actions to sign: those not yet signed that carry `alpha`. That is every real spend and the
/// wallet-controlled zero-value spends the builder pairs with change outputs, but not the
/// builder's pre-signed padding dummies. (Same rule as zcash_client_backend's
/// `create_pczt_supports_ironwood_output` test.)
fn signable(bundle: &orchard::pczt::Bundle) -> Vec<usize> {
    bundle
        .actions()
        .iter()
        .enumerate()
        .filter(|(_, a)| a.spend().spend_auth_sig().is_none() && a.spend().alpha().is_some())
        .map(|(i, _)| i)
        .collect()
}

#[async_trait]
impl Signer for LocalSigner {
    async fn sign(&self, pczt: pczt::Pczt, _melt_quote_id: &str) -> Result<pczt::Pczt> {
        // `alpha` is only visible on the parsed bundles, so read them through the Verifier.
        let (mut orchard, mut ironwood) = (vec![], vec![]);
        pczt::roles::verifier::Verifier::new(pczt.clone())
            .with_orchard::<Infallible, _>(|b| {
                orchard = signable(b);
                Ok(())
            })
            .map_err(|e| anyhow!("invalid Orchard bundle: {e:?}"))?
            .with_ironwood::<Infallible, _>(|b| {
                ironwood = signable(b);
                Ok(())
            })
            .map_err(|e| anyhow!("invalid Ironwood bundle: {e:?}"))?;
        anyhow::ensure!(!orchard.is_empty() || !ironwood.is_empty(), "PCZT has nothing to sign");
        let mut signer = pczt::roles::signer::Signer::new(pczt)
            .map_err(|e| anyhow!("PCZT not signable: {e:?}"))?;
        for i in orchard {
            signer
                .sign_orchard(i, &self.ask)
                .map_err(|e| anyhow!("{e:?}"))
                .with_context(|| format!("signing Orchard action {i}"))?;
        }
        for i in ironwood {
            signer
                .sign_ironwood(i, &self.ask)
                .map_err(|e| anyhow!("{e:?}"))
                .with_context(|| format!("signing Ironwood action {i}"))?;
        }
        Ok(signer.finish())
    }
}
