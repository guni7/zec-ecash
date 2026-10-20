//! Which chain this process works on: `ZEC_NETWORK=regtest|mainnet` (default regtest).
//!
//! Read once, from the real environment only (never from `.env`: that file belongs to the
//! regtest devnet, and a line in it must not silently switch every tool to mainnet). The only
//! things that differ by network are the consensus parameters ([`params`]), the defaults below
//! (state directory, light-wallet server, ports, confirmation depth), the wallet birthday and
//! the MAINNET labels; every code path is the same.
use std::{path::Path, sync::OnceLock};

use anyhow::{Result, bail};
use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkType, NetworkUpgrade, Parameters},
    local_consensus::LocalNetwork,
};



/// The local regtest devnet's parameters. Must match
/// [network.testnet_parameters.activation_heights] in devnet/zebrad-regtest.toml.
pub fn regtest_network() -> LocalNetwork {
    let h1 = Some(BlockHeight::from_u32(1));
    LocalNetwork {
        overwinter: h1,
        sapling: h1,
        blossom: h1,
        heartwood: h1,
        canopy: h1,
        nu5: h1,
        nu6: h1,
        nu6_1: h1,
        nu6_2: h1,
        nu6_3: h1,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    Regtest,
    Mainnet,
}

impl Network {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "regtest" => Ok(Self::Regtest),
            "mainnet" => Ok(Self::Mainnet),
            other => bail!("ZEC_NETWORK must be `regtest` or `mainnet`, not {other:?}"),
        }
    }

    pub fn is_mainnet(self) -> bool {
        self == Self::Mainnet
    }

    /// Consensus parameters: the devnet's [`regtest_network`], or Zcash mainnet.
    pub fn params(self) -> Params {
        match self {
            Self::Regtest => Params::Regtest(regtest_network()),
            Self::Mainnet => Params::Mainnet(MainNetwork),
        }
    }

    /// Where this network's keys, DBs, mint work dir and logs live, relative to the repo root.
    pub fn state_dir(self) -> &'static Path {
        Path::new(match self {
            Self::Regtest => "devnet",
            Self::Mainnet => "mainnet",
        })
    }

    /// Default light-wallet gRPC server (ZEC_LWD_URL overrides): Zebra's built-in one on the
    /// devnet, a public TLS endpoint on mainnet.
    pub fn default_lightwalletd(self) -> &'static str {
        match self {
            Self::Regtest => "http://127.0.0.1:9067",
            Self::Mainnet => "https://zec.rocks:443",
        }
    }

    /// Default local port for a service whose regtest port is `regtest_port`: mainnet adds 1000,
    /// so a mainnet process never answers a devnet one (and both can run side by side).
    pub fn port(self, regtest_port: u16) -> u16 {
        match self {
            Self::Regtest => regtest_port,
            Self::Mainnet => regtest_port + 1000,
        }
    }

    /// Default confirmation depth (ZEC_MIN_CONFIRMATIONS overrides): 1 on regtest (blocks are
    /// mined on demand), 10 on mainnet (ZIP 315's depth for outputs received from others).
    pub fn default_min_confirmations(self) -> u32 {
        match self {
            Self::Regtest => 1,
            Self::Mainnet => 10,
        }
    }

    /// "regtest" or "MAINNET" (capitals: it should stand out wherever it is printed).
    pub fn label(self) -> &'static str {
        match self {
            Self::Regtest => "regtest",
            Self::Mainnet => "MAINNET",
        }
    }
}

static CURRENT: OnceLock<Network> = OnceLock::new();

/// Reads `ZEC_NETWORK` (once). Binaries call this first so a bad value fails cleanly.
pub fn init() -> Result<Network> {
    if let Some(n) = CURRENT.get() {
        return Ok(*n);
    }
    let n = match std::env::var("ZEC_NETWORK") {
        Ok(v) => Network::parse(&v)?,
        Err(std::env::VarError::NotPresent) => Network::Regtest,
        Err(e) => bail!("ZEC_NETWORK: {e}"),
    };
    Ok(*CURRENT.get_or_init(|| n))
}

/// The process's network. Panics on an invalid `ZEC_NETWORK` if [`init`] was not called first.
pub fn current() -> Network {
    init().unwrap_or_else(|e| panic!("{e:#}"))
}

/// Consensus parameters of [`current`].
pub fn params() -> Params {
    current().params()
}

/// Consensus parameters for either network, so the wallet DB and every encoder take one type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Params {
    Regtest(LocalNetwork),
    Mainnet(MainNetwork),
}

impl Parameters for Params {
    fn network_type(&self) -> NetworkType {
        match self {
            Self::Regtest(p) => p.network_type(),
            Self::Mainnet(p) => p.network_type(),
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Self::Regtest(p) => p.activation_height(nu),
            Self::Mainnet(p) => p.activation_height(nu),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_defaults() {
        assert_eq!(Network::parse(" Mainnet ").unwrap(), Network::Mainnet);
        assert_eq!(Network::parse("regtest").unwrap(), Network::Regtest);
        assert!(Network::parse("testnet").is_err(), "only the two supported networks");
        assert_eq!(Network::Mainnet.port(50051), 51051);
        assert_eq!(Network::Regtest.port(50051), 50051);
        assert_eq!(Network::Mainnet.state_dir(), Path::new("mainnet"));
    }

    #[test]
    fn params_delegate() {
        let main = Network::Mainnet.params();
        assert_eq!(main.network_type(), NetworkType::Main);
        assert_eq!(main.activation_height(NetworkUpgrade::Nu6_3), Some(BlockHeight::from(3_428_143)), "Ironwood");
        let reg = Network::Regtest.params();
        assert_eq!(reg.network_type(), NetworkType::Regtest);
        assert_eq!(reg.activation_height(NetworkUpgrade::Nu6_3), regtest_network().activation_height(NetworkUpgrade::Nu6_3));
    }
}
