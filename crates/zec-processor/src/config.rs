//! Processor settings from the environment, with `.env` (in the working directory) as a
//! fallback. Real environment variables win over `.env`.
use std::{collections::HashMap, fs, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    /// Zebra's light-wallet gRPC (plaintext).
    pub lightwalletd: String,
    /// The mint reserve's unified full viewing key (Orchard `ak` = FROST group key), written by
    /// `zec-processor make-ufvk`. The processor holds no spending key at all.
    pub mint_ufvk: PathBuf,
    /// The reserve's view-only wallet DB.
    pub mint_db: PathBuf,
    /// The guardians' FROST public key package (from the DKG).
    pub frost_pubkeys: PathBuf,
    /// Guardian base URLs.
    pub guardians: Vec<String>,
    /// Per-round timeout for guardian requests.
    pub guardian_timeout: Duration,
    /// Quote table (`zec_deposit_address`).
    pub processor_db: PathBuf,
    /// Where cdk-mintd's `grpcprocessor` backend connects.
    pub grpc_addr: SocketAddr,
    /// Confirmations a deposit needs before its quote is PAID.
    pub confirmations: u32,
    pub min_zats: u64,
    pub max_zats: u64,
    pub sync_interval: Duration,
}

impl Config {
    pub fn load() -> Result<Self> {
        let dotenv = fs::read_to_string(".env").map(|s| parse_dotenv(&s)).unwrap_or_default();
        let get = |key: &str, default: &str| -> String {
            std::env::var(key)
                .ok()
                .or_else(|| dotenv.get(key).cloned())
                .unwrap_or_else(|| default.to_owned())
        };
        let num = |key: &str, default: &str| -> Result<u64> {
            get(key, default).parse().with_context(|| format!("{key} must be a whole number"))
        };

        Ok(Config {
            lightwalletd: get("ZEC_LIGHTWALLETD", "http://127.0.0.1:9067"),
            mint_ufvk: get("ZEC_MINT_UFVK", "devnet/keys/mint.ufvk").into(),
            mint_db: get("ZEC_MINT_DB", "devnet/mint-reserve.sqlite").into(),
            frost_pubkeys: get("ZEC_FROST_PUBKEYS", "devnet/keys/frost-pubkeys.json").into(),
            guardians: get(
                "ZEC_GUARDIANS",
                "http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103",
            )
            .split(',')
            .map(|u| u.trim().trim_end_matches('/').to_owned())
            .filter(|u| !u.is_empty())
            .collect(),
            guardian_timeout: Duration::from_secs(num("ZEC_GUARDIAN_TIMEOUT_SECS", "30")?),
            processor_db: get("ZEC_PROCESSOR_DB", "devnet/processor.sqlite").into(),
            grpc_addr: get("ZEC_GRPC_ADDR", "127.0.0.1:50051")
                .parse()
                .context("ZEC_GRPC_ADDR must be host:port")?,
            confirmations: num("ZEC_CONFIRMATIONS", "1")?
                .try_into()
                .context("ZEC_CONFIRMATIONS too large")?,
            min_zats: num("ZEC_MIN_ZATS", "1000")?,
            max_zats: num("ZEC_MAX_ZATS", "100000000000")?, // 1000 ZEC
            sync_interval: Duration::from_secs(num("ZEC_SYNC_INTERVAL_SECS", "7")?),
        })
    }
}

/// `KEY=value` lines; `#` comments, blank lines and an optional `export ` prefix are skipped,
/// and surrounding quotes are stripped.
fn parse_dotenv(text: &str) -> HashMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("export ").unwrap_or(l).split_once('='))
        .map(|(k, v)| {
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(v);
            (k.trim().to_owned(), v.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse_dotenv;

    #[test]
    fn dotenv_lines() {
        let env = parse_dotenv("# c\nexport A=1\nB = \"two\"\n\nC='3'\nnot a pair\n");
        assert_eq!(env["A"], "1");
        assert_eq!(env["B"], "two");
        assert_eq!(env["C"], "3");
        assert_eq!(env.len(), 3);
    }
}
