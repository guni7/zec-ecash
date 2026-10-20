//! `FrostSigner`: the coordinator side of 2-of-3 FROST. The processor holds no key share; it
//! collects commitments from the guardians, asks the first two to sign, and aggregates.
//! Any failure (fewer than 2 guardians, a refusal, a bad share) is an error, which the
//! withdrawal pipeline turns into FAILED with nothing broadcast.
use std::{collections::BTreeMap, path::Path, time::Duration};

use anyhow::{Context, Result, anyhow, bail, ensure};
use async_trait::async_trait;
use futures::{StreamExt, stream::FuturesUnordered};
use rand::RngCore;
use zec_frost::{
    redpallas::{
        Identifier, SigningPackage,
        keys::PublicKeyPackage,
        round1::SigningCommitments,
        round2::SignatureShare,
    },
    wire::{Client, Round1Request, Round1Response, Round2Request, Round2Response},
};
use zec_wallet::{Pczt, Signer, frost as pczt_frost};

/// One guardian: its base URL, and a client that trusts its certificate and signs its requests
/// with its secret (see `zec_frost::wire::auth`).
pub struct Endpoint {
    pub url: String,
    pub client: Client,
}

pub struct FrostSigner {
    guardians: Vec<Endpoint>,
    pubkeys: PublicKeyPackage,
    timeout: Duration,
}

impl FrostSigner {
    pub fn new(guardians: Vec<Endpoint>, pubkeys_path: &Path, timeout: Duration) -> Result<Self> {
        let pubkeys: PublicKeyPackage = serde_json::from_slice(
            &std::fs::read(pubkeys_path).with_context(|| format!("cannot read {}", pubkeys_path.display()))?,
        )
        .with_context(|| format!("cannot parse {}", pubkeys_path.display()))?;
        ensure!(guardians.len() >= zec_frost::MIN_SIGNERS as usize, "need at least {} guardians", zec_frost::MIN_SIGNERS);
        Ok(FrostSigner { guardians, pubkeys, timeout })
    }

    pub fn group_key(&self) -> Result<[u8; 32]> {
        zec_frost::group_key_bytes(&self.pubkeys)
    }

    /// Logs which guardians answer right now (informational; signing tolerates one being down).
    pub async fn log_guardians(&self) {
        for g in &self.guardians {
            let url = &g.url;
            match g.client.get_json::<zec_frost::wire::Status>(&format!("{url}/status"), Duration::from_secs(3)).await {
                Ok(s) => tracing::info!(%url, guardian = s.guardian, group_key = %s.group_key, "guardian up"),
                Err(e) => tracing::warn!(%url, "guardian not reachable: {e:#}"),
            }
        }
    }

    fn identifier(&self, guardian: u16) -> Result<Identifier> {
        let id = Identifier::try_from(guardian).map_err(|e| anyhow!("bad guardian id {guardian}: {e}"))?;
        ensure!(self.pubkeys.verifying_shares().contains_key(&id), "guardian {guardian} is not in the group");
        Ok(id)
    }
}

#[async_trait]
impl Signer for FrostSigner {
    async fn sign(&self, pczt: Pczt, quote_id: &str) -> Result<Pczt> {
        let spends = pczt_frost::spends_to_sign(&pczt)?;
        ensure!(!spends.is_empty(), "PCZT has nothing to sign");
        let sighash = pczt_frost::shielded_sighash(&pczt)?;
        let mut session = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut session);
        let session = hex::encode(session);

        // Round 1: ask everyone, keep the first two that answer properly.
        let req = Round1Request { session: session.clone(), quote_id: quote_id.to_owned(), action_count: spends.len() };
        let mut pending: FuturesUnordered<_> = self
            .guardians
            .iter()
            .map(|g| {
                let req = &req;
                async move {
                    let r: Result<Round1Response> = g.client.post_json(&format!("{}/round1", g.url), req, self.timeout).await;
                    (g, r)
                }
            })
            .collect();
        let mut chosen: Vec<(&Endpoint, Identifier, Vec<SigningCommitments>)> = vec![];
        let mut problems = vec![];
        while let Some((g, r)) = pending.next().await {
            let url = &g.url;
            match r.and_then(|r| {
                ensure!(r.commitments.len() == spends.len(), "{} commitments for {} spends", r.commitments.len(), spends.len());
                let commitments = r
                    .commitments
                    .iter()
                    .map(|c| SigningCommitments::deserialize(&hex::decode(c)?).map_err(|e| anyhow!("{e}")))
                    .collect::<Result<Vec<_>>>()?;
                Ok((self.identifier(r.guardian)?, commitments))
            }) {
                Ok((id, commitments)) if !chosen.iter().any(|(_, i, _)| *i == id) => {
                    chosen.push((g, id, commitments));
                    if chosen.len() == zec_frost::MIN_SIGNERS as usize {
                        break;
                    }
                }
                Ok(_) => problems.push(format!("{url}: duplicate guardian id")),
                Err(e) => problems.push(format!("{e:#}")),
            }
        }
        drop(pending);
        if chosen.len() < zec_frost::MIN_SIGNERS as usize {
            bail!(
                "only {} of {} guardians answered round 1 (need {}): {}",
                chosen.len(),
                self.guardians.len(),
                zec_frost::MIN_SIGNERS,
                problems.join("; ")
            );
        }
        tracing::info!(%quote_id, %session, guardians = ?chosen.iter().map(|c| &c.0.url).collect::<Vec<_>>(), "FROST round 1 done");

        // One signing package per spend, over the shielded sighash.
        let packages: Vec<SigningPackage> = (0..spends.len())
            .map(|i| SigningPackage::new(chosen.iter().map(|(_, id, c)| (*id, c[i])).collect(), &sighash))
            .collect();
        let req = Round2Request {
            session,
            quote_id: quote_id.to_owned(),
            pczt: hex::encode(pczt.clone().serialize().map_err(|e| anyhow!("{e:?}"))?),
            signing_packages: packages
                .iter()
                .map(|p| p.serialize().map(hex::encode).map_err(|e| anyhow!("{e}")))
                .collect::<Result<_>>()?,
        };

        // Round 2: both chosen guardians must sign (each verifies the withdrawal itself).
        let n_spends = spends.len();
        let results = futures::future::join_all(chosen.iter().map(|(g, id, _)| {
            let req = &req;
            async move {
                let url = &g.url;
                let r: Round2Response = g.client.post_json(&format!("{url}/round2"), req, self.timeout)
                    .await
                    .with_context(|| format!("guardian {url} did not sign"))?;
                ensure!(self.identifier(r.guardian)? == *id, "{url} answered as a different guardian");
                ensure!(r.shares.len() == n_spends, "{url}: {} shares for {n_spends} spends", r.shares.len());
                let shares = r
                    .shares
                    .iter()
                    .map(|s| SignatureShare::deserialize(&hex::decode(s)?).map_err(|e| anyhow!("{e}")))
                    .collect::<Result<Vec<_>>>()?;
                anyhow::Ok((*id, shares))
            }
        }))
        .await;
        let shares_by_guardian: Vec<(Identifier, Vec<SignatureShare>)> = results.into_iter().collect::<Result<_>>()?;

        // Aggregate per spend with that spend's alpha, check against rk, apply.
        let mut sigs = vec![];
        for (i, spend) in spends.iter().enumerate() {
            let shares: BTreeMap<Identifier, SignatureShare> =
                shares_by_guardian.iter().map(|(id, s)| (*id, s[i])).collect();
            ensure!(
                zec_frost::randomized_key(&self.pubkeys, &spend.alpha)? == spend.rk,
                "spend {i}: rk is not ak + [alpha]G for the guardians' group key"
            );
            let sig = zec_frost::aggregate(&packages[i], &shares, &self.pubkeys, &spend.alpha)
                .with_context(|| format!("spend {i}"))?;
            sigs.push((spend.pool, spend.index, sig));
        }
        tracing::info!(%quote_id, spends = sigs.len(), "FROST signatures aggregated");
        pczt_frost::apply_spend_auth_signatures(pczt, &sigs)
    }
}
