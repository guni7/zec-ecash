//! Sending and receiving ecash tokens, P2PK keys, and small CLI helpers.
use std::{collections::HashMap, path::Path, str::FromStr};

use anyhow::{Context, Result, anyhow, bail};
use cdk::{
    Amount,
    nuts::{CurrencyUnit, PublicKey, SecretKey, SpendingConditions, Token},
    wallet::{ReceiveOptions, SendKind, SendOptions, Wallet},
};
use cdk_common::bitcoin::{
    Network,
    bip32::{ChildNumber, DerivationPath, Xpriv},
};


/// The wallet's P2PK key: CDK's deterministic P2PK path m/129373'/10'/0'/0/0 from the seed
/// (`cdk::wallet::p2pk`, purpose 129373), so the same seed always gives the same key.
pub fn p2pk_key(seed: &[u8; 64]) -> Result<SecretKey> {
    let path = DerivationPath::from(vec![
        ChildNumber::from_hardened_idx(129373)?,
        ChildNumber::from_hardened_idx(10)?,
        ChildNumber::from_hardened_idx(0)?,
        ChildNumber::from_normal_idx(0)?,
        ChildNumber::from_normal_idx(0)?,
    ]);
    let xpriv = Xpriv::new_master(Network::Bitcoin, seed)?;
    let key = xpriv.derive_priv(&cdk::SECP256K1, &path)?.private_key;
    Ok(SecretKey::from(key))
}

/// Creates a token for `zat`, optionally P2PK-locked to `lock`, and returns it encoded (cashuB).
/// `compact` drops each proof's DLEQ proof (NUT-12), roughly halving the token: smaller QR
/// codes, but the receiver can no longer verify the token offline before redeeming it.
/// P2PK-locked tokens always keep their DLEQ: their whole point is that the receiver can accept
/// them offline, which needs the DLEQ proofs.
pub async fn send(wallet: &Wallet, zat: u64, lock: Option<PublicKey>, compact: bool) -> Result<String> {
    Ok(send_tracked(wallet, zat, lock, compact).await?.0)
}

/// [`send`], also returning the send's operation id (for [`reclaim`]: taking it back).
pub async fn send_tracked(wallet: &Wallet, zat: u64, lock: Option<PublicKey>, compact: bool) -> Result<(String, String)> {
    let compact = compact && lock.is_none();
    // OnlineExact: swap with the mint when no exact proof set exists. Not OnlineTolerance: in
    // cdk 0.18.2 any tolerance skips the swap and is only enforced offline, so an online send
    // ships whatever it selected (`send 2000` sent a 4096 proof).
    let opts = SendOptions {
        send_kind: SendKind::OnlineExact,
        conditions: lock.map(|pk| SpendingConditions::new_p2pk(pk, None)),
        ..Default::default()
    };
    let prepared = wallet.prepare_send(Amount::from(zat), opts).await.map_err(|e| match e {
        cdk::Error::InsufficientFunds => anyhow!("not enough ecash: balance is below {zat} zat"),
        e => anyhow!(e),
    })?;
    let operation = prepared.operation_id();
    let mut token = prepared.confirm(None).await?;
    if compact {
        strip_dleq(&mut token);
    }
    let encoded = token.to_string();
    eprintln!(
        "token: {} zat in {} proofs, {} chars",
        token.value().map(u64::from).unwrap_or(0),
        proof_count(&token),
        encoded.len()
    );
    Ok((encoded, operation.to_string()))
}

/// Swaps all of the wallet's proofs for the minimal (powers-of-two) set for its balance.
/// One swap; the value only changes by the mint's input fee, if any.
pub async fn consolidate(wallet: &Wallet) -> Result<(usize, usize, u64)> {
    let proofs = wallet.get_unspent_proofs().await?;
    let before = proofs.len();
    if before <= 1 {
        let total = proofs.iter().map(|p| u64::from(p.amount)).sum();
        return Ok((before, before, total));
    }
    wallet.swap(None, cdk::amount::SplitTarget::None, proofs, None, false, false).await?;
    let after = wallet.get_unspent_proofs().await?;
    Ok((before, after.len(), after.iter().map(|p| u64::from(p.amount)).sum()))
}

fn strip_dleq(token: &mut Token) {
    if let Token::TokenV4(t) = token {
        for k in &mut t.token {
            for p in &mut k.proofs {
                p.dleq = None;
            }
        }
    }
}

/// Tokens this wallet created that nobody has redeemed yet: (operation id, amount, unix time
/// created, token text). Uses the mint to tell claimed from unclaimed.
pub async fn pending_sends(wallet: &Wallet) -> Result<Vec<(String, u64, u64, String)>> {
    let mut out = vec![];
    for id in wallet.get_pending_sends().await? {
        if wallet.check_send_status(id).await? {
            continue; // claimed by the recipient (this also finalizes the record)
        }
        let Some(record) = wallet.localstore.get_saga(&id).await? else { continue };
        let (amount, token) = match &record.data {
            cdk_common::wallet::OperationData::Send(d) => (u64::from(d.amount), d.token.clone().unwrap_or_default()),
            _ => continue,
        };
        out.push((id.to_string(), amount, record.created_at, token));
    }
    Ok(out)
}

/// Takes back an unredeemed token this wallet created (swaps its proofs back at the mint).
/// Afterwards the token is worthless to whoever holds it.
pub async fn reclaim(wallet: &Wallet, id: &str) -> Result<u64> {
    let id = id.parse().map_err(|e| anyhow!("not an operation id (see `pending`): {e}"))?;
    if wallet.check_send_status(id).await? {
        bail!("that token was already redeemed by its recipient");
    }
    Ok(u64::from(wallet.revoke_send(id).await?))
}

/// Keysets cached in the wallet DB, collected across every mint URL in it: cdk-redb 0.18.2 only
/// links a keyset to the URL it was first fetched under, so after a mint URL change the current
/// URL lists none. A keyset id is a hash of its keys, so a matching id means the same mint keys.
pub async fn cached_keyset_infos(wallet: &Wallet) -> Result<Vec<cdk::nuts::KeySetInfo>> {
    let mut infos: Vec<cdk::nuts::KeySetInfo> = vec![];
    for url in wallet.localstore.get_mints().await?.into_keys() {
        for ks in wallet.localstore.get_mint_keysets(url).await?.unwrap_or_default() {
            if !infos.iter().any(|k| k.id == ks.id) {
                infos.push(ks);
            }
        }
    }
    if infos.is_empty() {
        bail!("no cached keys for {}: run any online command once, e.g. balance", wallet.mint_url);
    }
    Ok(infos)
}

/// Outcome of paying a NUT-18 request.
pub struct Paid {
    pub amount: u64,
    pub target: String,
    pub status: i32,
    pub body: String,
    /// The proofs as a token (P2PK-locked when the request asked for it).
    pub token: String,
    /// The key the proofs are locked to, if any: only its holder can redeem them.
    pub locked_to: Option<PublicKey>,
}

/// Pays a NUT-18 payment request (creqA...) over its HTTP POST transport. If the request asks
/// for a P2PK lock (nut10), every proof is locked to exactly that key, with DLEQ proofs and no
/// locktime, refund keys or other conditions (what a zec-ecash POS accepts: the payee's phone
/// collects the payment later). A refused locked payment can then be redeemed only by the payee.
pub async fn pay(wallet: &Wallet, request: &str, amount: Option<u64>) -> Result<Paid> {
    use cdk::nuts::{Kind, PaymentRequest, PaymentRequestPayload, TransportType};
    let req = PaymentRequest::from_str(request.trim()).map_err(|e| anyhow!("not a NUT-18 payment request: {e}"))?;
    if let Some(u) = &req.unit
        && *u != CurrencyUnit::custom(crate::UNIT)
    {
        bail!("wrong unit: the request is in {u}, this wallet only pays {}", crate::UNIT);
    }
    if !req.mints.is_empty() && !req.mints.contains(&wallet.mint_url) {
        bail!("the request doesn't accept our mint {} (it accepts {:?})", wallet.mint_url, req.mints);
    }
    let amount = amount.or(req.amount.map(u64::from)).context("the request has no amount")?;
    let target = req
        .transports
        .iter()
        .find(|t| t._type == TransportType::HttpPost)
        .map(|t| t.target.clone())
        .context("the request has no HTTP POST transport")?;

    let locked_to = match &req.nut10 {
        Some(n) if n.kind == Kind::P2PK => {
            if n.tags.as_ref().is_some_and(|t| !t.is_empty()) {
                bail!("the request's lock has extra conditions ({:?}); this wallet pays plain P2PK locks only", n.tags);
            }
            Some(PublicKey::from_str(&n.data).map_err(|e| anyhow!("request's P2PK key is invalid: {e}"))?)
        }
        Some(n) => bail!("the request asks for an unsupported lock kind {:?}", n.kind),
        None => None,
    };
    let conditions = locked_to.map(|to| SpendingConditions::new_p2pk(to, None));
    let opts = SendOptions { send_kind: SendKind::OnlineExact, conditions, ..Default::default() };
    let prepared = wallet.prepare_send(Amount::from(amount), opts).await.map_err(|e| match e {
        cdk::Error::InsufficientFunds => anyhow!("not enough ecash: balance is below {amount} zat"),
        e => anyhow!(e),
    })?;
    let token = prepared.confirm(None).await?;
    let proofs = token.proofs(&cached_keyset_infos(wallet).await?)?;
    let payload = PaymentRequestPayload {
        id: req.payment_id.clone(),
        memo: None,
        mint: wallet.mint_url.clone(),
        unit: CurrencyUnit::custom(crate::UNIT),
        proofs,
    };
    let resp = bitreq::post(target.as_str())
        .with_header("content-type", "application/json")
        .with_body(serde_json::to_vec(&payload)?)
        .with_timeout(60)
        .send_async()
        .await
        .map_err(|e| anyhow!("cannot reach {target}: {e}"))?;
    Ok(Paid {
        amount,
        target,
        status: resp.status_code,
        body: resp.as_str().unwrap_or("").to_owned(),
        token: token.to_string(),
        locked_to,
    })
}

/// One proof's offline verdict.
pub struct ProofCheck {
    pub amount: u64,
    pub keyset: String,
    /// DLEQ against the cached mint key for this keyset and amount.
    pub dleq: Result<(), String>,
    /// P2PK lock target, if any, and whether extra conditions (locktime, refund, multisig) apply.
    pub lock: Option<(PublicKey, bool)>,
}

/// Offline: verifies every proof's DLEQ (NUT-12) against keysets cached in the wallet DB, and
/// reports P2PK locks. No network: a mint whose keys were never cached can't be checked.
pub async fn check(wallet: &Wallet, encoded: &str) -> Result<Vec<ProofCheck>> {
    let token = Token::from_str(encoded.trim()).map_err(|e| anyhow!("not a Cashu token: {e}"))?;
    check_token_target(&token, &wallet.mint_url.to_string())?;
    let infos = cached_keyset_infos(wallet).await?;
    let mut cached = vec![];
    for info in &infos {
        if let Some(keys) = wallet.localstore.get_keys(&info.id).await? {
            cached.push((info.id, keys));
        }
    }
    let proofs = token
        .proofs(&infos)
        .map_err(|e| anyhow!("token uses a keyset this wallet hasn't cached: {e}"))?;
    let mut out = vec![];
    for proof in proofs {
        let dleq = match cached.iter().find(|(id, _)| *id == proof.keyset_id) {
            None => Err(format!("keys for keyset {} not cached", proof.keyset_id)),
            Some((_, keys)) => match keys.amount_key(proof.amount) {
                None => Err(format!("keyset has no key for amount {}", proof.amount)),
                Some(mint_key) => match proof.dleq {
                    None => Err("no DLEQ proof in token (sent compact)".into()),
                    Some(_) => proof.verify_dleq(mint_key).map_err(|e| format!("invalid: {e}")),
                },
            },
        };
        let lock = match SpendingConditions::try_from(&proof.secret) {
            Ok(SpendingConditions::P2PKConditions { data, conditions }) => {
                let extra = conditions.is_some_and(|c| {
                    c.locktime.is_some() || c.refund_keys.is_some() || c.pubkeys.is_some() || c.num_sigs.unwrap_or(1) > 1
                });
                Some((data, extra))
            }
            _ => None,
        };
        out.push(ProofCheck { amount: u64::from(proof.amount), keyset: proof.keyset_id.to_string(), dleq, lock });
    }
    Ok(out)
}

/// Number of proofs in a token (read from the token itself; no keysets needed).
pub fn proof_count(token: &Token) -> usize {
    match token {
        Token::TokenV4(t) => t.token.iter().map(|k| k.proofs.len()).sum(),
        Token::TokenV3(t) => t.token.iter().map(|k| k.proofs.len()).sum(),
    }
}

/// Why a token can't be received by this wallet, checked before contacting the mint.
pub fn check_token_target(token: &Token, wallet_mint: &str) -> Result<()> {
    let unit = token.unit().unwrap_or_default();
    if unit != CurrencyUnit::custom(crate::UNIT) {
        bail!("wrong unit: this token is in {unit}, this wallet only takes {}", crate::UNIT);
    }
    let token_mint = token.mint_url().map_err(|e| anyhow!("token has no single mint URL: {e}"))?;
    let ours = cdk::mint_url::MintUrl::from_str(wallet_mint)?;
    if token_mint != ours {
        bail!(
            "unknown mint URL: the token is from {token_mint}, this wallet uses {ours} \
             (set ZEC_MINT_URL / --mint to the URL the token was minted under)"
        );
    }
    Ok(())
}

/// Redeems `encoded` at the mint, signing for any P2PK lock with this wallet's key.
pub async fn receive(wallet: &Wallet, seed: &[u8; 64], encoded: &str) -> Result<u64> {
    let token = Token::from_str(encoded.trim()).map_err(|e| anyhow!("not a Cashu token: {e}"))?;
    check_token_target(&token, &wallet.mint_url.to_string())?;
    let opts = ReceiveOptions { p2pk_signing_keys: vec![p2pk_key(seed)?], ..Default::default() };
    let amount = wallet.receive(encoded.trim(), opts).await.map_err(|e| match e {
        cdk::Error::TokenAlreadySpent => anyhow!("already spent: this token was redeemed before"),
        cdk::Error::UnsupportedUnit => anyhow!("wrong unit: this wallet only takes {}", crate::UNIT),
        cdk::Error::IncorrectMint => anyhow!("unknown mint URL: the token is from a different mint"),
        e @ (cdk::Error::NUT11(_) | cdk::Error::NUT10(_)) => {
            anyhow!("token is locked to a different key (P2PK): {e}")
        }
        e => anyhow!(e).context("the mint did not accept the token"),
    })?;
    Ok(u64::from(amount))
}

/// Prints a token as a terminal QR code (if it fits in one).
pub fn print_qr(data: &str) {
    match qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::L) {
        Ok(code) => println!(
            "{}",
            code.render::<qrcode::render::unicode::Dense1x2>()
                .dark_color(qrcode::render::unicode::Dense1x2::Light)
                .light_color(qrcode::render::unicode::Dense1x2::Dark)
                .quiet_zone(true)
                .build()
        ),
        Err(e) => eprintln!("(token too large for a single QR code: {e}; copy the text instead)"),
    }
}

/// `KEY=value` lines from a dotenv file (missing file: empty).
pub fn read_dotenv(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("export ").unwrap_or(l).split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_matches(|c| c == '"' || c == '\'').to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p2pk_key_is_deterministic_per_seed() {
        let a = p2pk_key(&[1; 64]).unwrap().public_key();
        assert_eq!(a, p2pk_key(&[1; 64]).unwrap().public_key());
        assert_ne!(a, p2pk_key(&[2; 64]).unwrap().public_key());
    }

    fn token(mint: &str, unit: &str) -> Token {
        Token::new(cdk::mint_url::MintUrl::from_str(mint).unwrap(), vec![], None, CurrencyUnit::custom(unit))
    }

    #[test]
    fn token_target_checks() {
        let mint = "https://172.20.10.3:5173/mint";
        assert!(check_token_target(&token(mint, "zat"), mint).is_ok());
        // trailing slash / case differences in the URL are the same mint
        assert!(check_token_target(&token(mint, "zat"), "https://172.20.10.3:5173/mint/").is_ok());
        let e = check_token_target(&token(mint, "sat"), mint).unwrap_err().to_string();
        assert!(e.starts_with("wrong unit"), "{e}");
        let e = check_token_target(&token("http://127.0.0.1:8085", "zat"), mint).unwrap_err().to_string();
        assert!(e.starts_with("unknown mint URL"), "{e}");
    }
}
