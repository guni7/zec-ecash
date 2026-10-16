//! Wallet-side parameters for the local regtest chain.
//! Must match [network.testnet_parameters.activation_heights] in devnet/zebrad-regtest.toml.
use zcash_protocol::consensus::BlockHeight;
use zcash_protocol::local_consensus::LocalNetwork;

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

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

    #[test]
    fn ironwood_active_from_block_1_on_regtest() {
        let net = regtest_network();
        assert!(net.is_nu_active(NetworkUpgrade::Nu6_3, BlockHeight::from_u32(1)));
    }
}
