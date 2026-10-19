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
    /// Depth a deposit needs before its quote is PAID, and a withdrawal before it settles PAID
    /// (ZEC_MIN_CONFIRMATIONS; default by network, see [`default_min_confirmations`]).
    pub min_confirmations: u32,
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
            min_confirmations: resolve_min_confirmations(
                std::env::var("ZEC_MIN_CONFIRMATIONS").ok().or_else(|| dotenv.get("ZEC_MIN_CONFIRMATIONS").cloned()).as_deref(),
                std::env::var("ZEC_CONFIRMATIONS").ok().or_else(|| dotenv.get("ZEC_CONFIRMATIONS").cloned()).as_deref(),
                zcash_protocol::consensus::Parameters::network_type(&zec_wallet::regtest::regtest_network()),
            )?,
            min_zats: num("ZEC_MIN_ZATS", "1000")?,
            max_zats: num("ZEC_MAX_ZATS", "100000000000")?, // 1000 ZEC
            sync_interval: Duration::from_secs(num("ZEC_SYNC_INTERVAL_SECS", "7")?),
        })
    }
}

/// Default confirmation depth per network: 1 on regtest (blocks are mined on demand), 10
/// elsewhere (ZIP 315's depth for outputs received from others).
pub fn default_min_confirmations(network: zcash_protocol::consensus::NetworkType) -> u32 {
    match network {
        zcash_protocol::consensus::NetworkType::Regtest => 1,
        _ => 10,
    }
}

/// ZEC_MIN_CONFIRMATIONS if set, else the old name ZEC_CONFIRMATIONS (with a warning), else the
/// network default. Must be at least 1.
fn resolve_min_confirmations(
    explicit: Option<&str>,
    legacy: Option<&str>,
    network: zcash_protocol::consensus::NetworkType,
) -> Result<u32> {
    let (name, value) = match (explicit, legacy) {
        (Some(v), _) => ("ZEC_MIN_CONFIRMATIONS", v),
        (None, Some(v)) => {
            eprintln!("warning: ZEC_CONFIRMATIONS is deprecated; use ZEC_MIN_CONFIRMATIONS");
            ("ZEC_CONFIRMATIONS", v)
        }
        (None, None) => return Ok(default_min_confirmations(network)),
    };
    let n: u32 = value.trim().parse().with_context(|| format!("{name} must be a whole number"))?;
    anyhow::ensure!(n >= 1, "{name} must be at least 1");
    Ok(n)
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
    fn min_confirmations_defaults_and_overrides() {
        use super::{default_min_confirmations, resolve_min_confirmations};
        use zcash_protocol::consensus::NetworkType::{Main, Regtest, Test};
        assert_eq!(default_min_confirmations(Regtest), 1);
        assert_eq!(default_min_confirmations(Main), 10);
        assert_eq!(default_min_confirmations(Test), 10);
        assert_eq!(resolve_min_confirmations(None, None, Regtest).unwrap(), 1);
        assert_eq!(resolve_min_confirmations(None, None, Main).unwrap(), 10);
        assert_eq!(resolve_min_confirmations(Some("3"), None, Regtest).unwrap(), 3);
        assert_eq!(resolve_min_confirmations(Some("3"), Some("7"), Main).unwrap(), 3, "new name wins");
        assert_eq!(resolve_min_confirmations(None, Some("7"), Main).unwrap(), 7, "old name still works");
        assert!(resolve_min_confirmations(Some("0"), None, Main).is_err());
        assert!(resolve_min_confirmations(Some("x"), None, Main).is_err());
    }

    #[test]
    fn dotenv_lines() {
        let env = parse_dotenv("# c\nexport A=1\nB = \"two\"\n\nC='3'\nnot a pair\n");
        assert_eq!(env["A"], "1");
        assert_eq!(env["B"], "two");
        assert_eq!(env["C"], "3");
        assert_eq!(env.len(), 3);
    }
}
