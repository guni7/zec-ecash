//! ZEC payment processor: implements cdk_common::payment::MintPayment and serves it
//! to stock cdk-mintd over gRPC (backend = "grpcprocessor"). Reserves live in the
//! Ironwood pool; addresses use the Orchard-format receiver, which Ironwood shares.
//!
//! Phase 1: deposits (mint quotes). Phase 2/4: withdrawals (melt quotes), authorized by 2-of-3
//! FROST guardians; the processor's wallet is view-only and it holds no key share.
//! Configure with ZEC_* variables or `.env` (see config.rs), then:
//!   cargo run -p zec-processor -- make-ufvk   # once, after the DKG: writes devnet/keys/mint.ufvk
//!   cargo run -p zec-processor
mod backend;
mod config;
mod frost_signer;
mod reserves;
mod status;
mod store;
mod withdraw;

use std::sync::Arc;

use anyhow::Context;
use cdk_common::payment::MintPayment;
use cdk_payment_processor::PaymentProcessorServer;
use zec_wallet::Wallet;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Size-capped: devnet/logs/processor.log (+ .1 .. .5), see the devlog crate.
    let log = devlog::init(
        std::path::Path::new("devnet/logs"),
        "processor",
        "info,zcash_client_backend=warn,zcash_client_sqlite=warn",
    )?;
    eprintln!("zec-processor: logging to {}", log.display());
    let cfg = config::Config::load()?;
    if std::env::args().nth(1).as_deref() == Some("make-ufvk") {
        return make_ufvk(&cfg);
    }
    tracing::info!(?cfg, "starting zec-processor");
    // Fail loudly: the processor never generates or replaces the reserve's keys.
    for (path, what) in [(&cfg.mint_ufvk, "ZEC_MINT_UFVK"), (&cfg.frost_pubkeys, "ZEC_FROST_PUBKEYS")] {
        anyhow::ensure!(
            path.exists(),
            "{what} file {} is missing. The reserve's keys are never generated implicitly: restore \
             devnet/keys/, or create new ones with scripts/devnet-reset.sh --new-keys",
            path.display()
        );
    }

    let signer = frost_signer::FrostSigner::new(cfg.guardians.clone(), &cfg.frost_pubkeys, cfg.guardian_timeout)?;
    let ufvk = zec_wallet::frost::read_ufvk(&cfg.mint_ufvk)?;
    anyhow::ensure!(
        zec_wallet::frost::ufvk_ak(&ufvk)? == signer.group_key()?,
        "{}'s ak is not the guardians' group key ({})",
        cfg.mint_ufvk.display(),
        cfg.frost_pubkeys.display()
    );
    let ufvk = ufvk.encode(&zec_wallet::regtest::regtest_network());
    let mut wallet = Wallet::open_or_import_ufvk(&ufvk, &cfg.mint_db, &cfg.lightwalletd)
        .await
        .with_context(|| format!("cannot open the mint reserve wallet {}", cfg.mint_db.display()))?;
    // Reserve notes below the deposit depth are neither spendable nor counted as spendable.
    wallet.set_min_confirmations(cfg.min_confirmations)?;
    tracing::info!(address = %wallet.address()?, "mint reserve wallet (view-only)");
    signer.log_guardians().await;
    let signer = Arc::new(signer);
    let store = store::QuoteStore::open(&cfg.processor_db)?;

    let started = std::time::Instant::now();
    tokio::task::spawn_blocking(zec_wallet::warm_proving_key).await??;
    tracing::info!(elapsed = ?started.elapsed(), "Orchard proving key ready");

    let backend = Arc::new(backend::ZecBackend::new(cfg.clone(), store, wallet, signer));
    backend.start().await?;
    let (monitor, status_backend) = (backend.reserve_monitor(), backend.clone());
    tokio::spawn(async move {
        if let Err(e) = status::serve(cfg.status_addr, monitor, status_backend).await {
            tracing::error!("{e:#}");
        }
    });

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

/// Coordinator step after the DKG: the mint's UFVK, with Orchard `ak` = the guardians' group
/// key and fresh random `nk`/`rivk`. Refuses to overwrite an existing one (it is the reserve).
fn make_ufvk(cfg: &config::Config) -> anyhow::Result<()> {
    anyhow::ensure!(!cfg.mint_ufvk.exists(), "{} already exists; delete it only with the whole devnet", cfg.mint_ufvk.display());
    let pubkeys: zec_frost::redpallas::keys::PublicKeyPackage = serde_json::from_slice(
        &std::fs::read(&cfg.frost_pubkeys).with_context(|| format!("cannot read {}", cfg.frost_pubkeys.display()))?,
    )?;
    let ufvk = zec_wallet::frost::frost_ufvk(zec_frost::group_key_bytes(&pubkeys)?)?;
    if let Some(dir) = cfg.mint_ufvk.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&cfg.mint_ufvk, ufvk.encode(&zec_wallet::regtest::regtest_network()) + "\n")?;
    println!("wrote {} (Orchard ak = FROST group key)", cfg.mint_ufvk.display());
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
