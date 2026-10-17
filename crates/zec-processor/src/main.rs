//! ZEC payment processor: implements cdk_common::payment::MintPayment and serves it
//! to stock cdk-mintd over gRPC (backend = "grpcprocessor"). Reserves live in the
//! Ironwood pool; addresses use the Orchard-format receiver, which Ironwood shares.
//!
//! Phase 1: deposits (mint quotes). Phase 2: withdrawals (melt quotes), signed with the
//! single mint key. Configure with ZEC_* variables or `.env` (see config.rs), then:
//!   cargo run -p zec-processor
mod backend;
mod config;
mod store;
mod withdraw;

use std::sync::Arc;

use anyhow::Context;
use cdk_common::payment::MintPayment;
use cdk_payment_processor::PaymentProcessorServer;
use zec_wallet::{LocalSigner, Wallet};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,zcash_client_backend=warn,zcash_client_sqlite=warn".into()),
        )
        .init();
    let cfg = config::Config::load()?;
    tracing::info!(?cfg, "starting zec-processor");

    let wallet = Wallet::open_or_create(&cfg.mint_seed, &cfg.mint_wallet_db(), &cfg.lightwalletd)
        .await
        .with_context(|| format!("cannot open the mint reserve wallet {}", cfg.mint_seed.display()))?;
    tracing::info!(address = %wallet.address()?, "mint reserve wallet");
    let store = store::QuoteStore::open(&cfg.processor_db)?;
    // Phase 2 signs withdrawals with the single mint key; Phase 4 swaps in a FROST signer.
    let signer = Arc::new(LocalSigner::from_seed_path(&cfg.mint_seed)?);

    let started = std::time::Instant::now();
    tokio::task::spawn_blocking(zec_wallet::warm_proving_key).await??;
    tracing::info!(elapsed = ?started.elapsed(), "Orchard proving key ready");

    let backend = Arc::new(backend::ZecBackend::new(cfg.clone(), store, wallet, signer));
    backend.start().await?;

    // PaymentProcessorServer binds inside a background task, so a busy port (e.g. an old
    // processor still shutting down) would otherwise fail silently while we report "serving".
    drop(
        std::net::TcpListener::bind(cfg.grpc_addr)
            .with_context(|| format!("{} is already in use", cfg.grpc_addr))?,
    );
    let mut server = PaymentProcessorServer::new(
        backend.clone(),
        &cfg.grpc_addr.ip().to_string(),
        cfg.grpc_addr.port(),
    )?;
    server.start(None).await?;
    tracing::info!(addr = %cfg.grpc_addr, "payment processor gRPC serving; Ctrl-C to stop");

    tokio::signal::ctrl_c().await?;
    tracing::info!("shutting down");
    server.stop().await?;
    backend.stop().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use zcash_protocol::consensus::{BlockHeight, MainNetwork, NetworkUpgrade, Parameters, TestNetwork};

    /// The pinned crates must know Ironwood (NU6.3); mainnet activated at block 3,428,143.
    #[test]
    fn crates_know_ironwood_activation() {
        assert_eq!(
            MainNetwork.activation_height(NetworkUpgrade::Nu6_3),
            Some(BlockHeight::from_u32(3_428_143))
        );
        assert!(TestNetwork.activation_height(NetworkUpgrade::Nu6_3).is_some());
    }
}
