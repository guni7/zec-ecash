//! Wallet-side parameters for the local regtest chain.
//! Must match [network.testnet_parameters.activation_heights] in devnet/zebrad-regtest.toml.

pub use zec_network::regtest_network;

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::{BlockHeight, NetworkUpgrade, Parameters};

    #[test]
    fn ironwood_active_from_block_1_on_regtest() {
        let net = regtest_network();
        assert!(net.is_nu_active(NetworkUpgrade::Nu6_3, BlockHeight::from_u32(1)));
    }
}
