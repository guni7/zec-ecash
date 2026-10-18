//! Sending and receiving ecash tokens, P2PK keys, and small CLI helpers.
use std::{collections::HashMap, path::Path, str::FromStr};

use anyhow::{Result, anyhow, bail};
use cdk::{
    Amount,
    nuts::{CurrencyUnit, PublicKey, SecretKey, SpendingConditions, Token},
    wallet::{ReceiveOptions, SendKind, SendOptions, Wallet},
};
use cdk_common::bitcoin::{
    Network,
    bip32::{ChildNumber, DerivationPath, Xpriv},
};

/// How much a send may overpay to avoid a swap with the mint. Zero keeps amounts exact: any
/// overpayment would go to the recipient for good. (A non-zero tolerance would let `send`
/// skip the swap more often.)
const SEND_TOLERANCE: Amount = Amount::ZERO;

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
pub async fn send(wallet: &Wallet, zat: u64, lock: Option<PublicKey>) -> Result<String> {
    let opts = SendOptions {
        send_kind: SendKind::OnlineTolerance(SEND_TOLERANCE),
        conditions: lock.map(|pk| SpendingConditions::new_p2pk(pk, None)),
        ..Default::default()
    };
    let prepared = wallet.prepare_send(Amount::from(zat), opts).await.map_err(|e| match e {
        cdk::Error::InsufficientFunds => anyhow!("not enough ecash: balance is below {zat} zat"),
        e => anyhow!(e),
    })?;
    let token = prepared.confirm(None).await?;
    Ok(token.to_string())
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
