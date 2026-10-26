//! ZEC payment processor: implements cdk_common::payment::MintPayment and serves it
//! to stock cdk-mintd over gRPC (backend = "grpcprocessor"). Reserves live in the
//! Ironwood pool; addresses use the Orchard-format receiver, which Ironwood shares.
//!
//! Phase 1: deposits (mint quotes). Phase 2/4: withdrawals (melt quotes), authorized by 2-of-3
//! FROST guardians; the processor's wallet is view-only and it holds no key share.
//! Configure with ZEC_* variables or `.env` (see config.rs), then:
//!   cargo run -p zec-processor -- make-ufvk   # once, after the DKG: writes devnet/keys/mint.ufvk
//!   cargo run -p zec-processor -- operator-actions   # flagged withdrawals, with address, txid
//!                                                     # and reason (/reserves shows only id + amount)
//!   cargo run -p zec-processor -- resolve <quote_id>   # clear an operator-action flag once a
//!                                                       # person has dealt with it (see /reserves)
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
    let network = zec_wallet::network::init()?;
    // Size-capped: <devnet|mainnet>/logs/processor.log (+ .1 .. .5; ZEC_LOG_DIR overrides the
    // directory), see the devlog crate. On mainnet every line starts with "MAINNET".
    let log_dir = std::env::var_os("ZEC_LOG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| network.state_dir().join("logs"));
    let log = devlog::init_labeled(
        &log_dir,
        "processor",
        "info,zcash_client_backend=warn,zcash_client_sqlite=warn",
        network.is_mainnet().then_some("MAINNET "),
    )?;
    if network.is_mainnet() {
        eprintln!("zec-processor: *** MAINNET (real ZEC) *** logging to {}", log.display());
    } else {
        eprintln!("zec-processor: logging to {}", log.display());
    }
    let cfg = config::Config::load()?;
    if std::env::args().nth(1).as_deref() == Some("make-ufvk") {
        return make_ufvk(&cfg);
    }
    if std::env::args().nth(1).as_deref() == Some("operator-actions") {
        let store = store::QuoteStore::open(&cfg.processor_db)?;
        let rows = store.needing_operator_action()?;
        if rows.is_empty() {
            println!("{}: no withdrawals need an operator", cfg.network.label());
        }
        for w in &rows {
            println!(
                "{}: withdrawal {} flagged at {} (unix)\n  {} zat (+{} fee) to {}\n  txid {}\n  {}",
                cfg.network.label(),
                w.quote_id,
                w.updated_at,
                w.amount_zats,
                w.fee_zats,
                w.address,
                w.txid.as_deref().unwrap_or("none"),
                w.operator_action.as_deref().unwrap_or("")
            );
        }
        if !rows.is_empty() {
            println!("After paying the recipient by other means: zec-processor resolve <quote_id>");
        }
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("resolve") {
        let quote_id = std::env::args().nth(2).context("usage: zec-processor resolve <quote_id>")?;
        let store = store::QuoteStore::open(&cfg.processor_db)?;
        let w = store.withdrawal(&quote_id)?.with_context(|| format!("no withdrawal {quote_id}"))?;
        let reason = store
            .resolve_operator_action(&quote_id)?
            .with_context(|| format!("withdrawal {quote_id} is not flagged (or already resolved)"))?;
        tracing::warn!(%quote_id, %reason, "operator action resolved by hand");
        println!("{}: cleared {quote_id} ({} zat to {}): {reason}", cfg.network.label(), w.amount_zats, w.address);
        println!("It is not watched or retried any more; pay the recipient by other means if needed.");
        return Ok(());
    }
    tracing::info!(network = cfg.network.label(), ?cfg, "starting zec-processor");
    // Fail loudly: the processor never generates or replaces the reserve's keys.
    for (path, what) in [(&cfg.mint_ufvk, "ZEC_MINT_UFVK"), (&cfg.frost_pubkeys, "ZEC_FROST_PUBKEYS")] {
        anyhow::ensure!(
            path.exists(),
            "{what} file {} is missing. The reserve's keys are never generated implicitly: restore \
             {}/keys/, or create new ones with {}",
            path.display(),
            cfg.network.state_dir().display(),
            if cfg.network.is_mainnet() { "the DKG ceremony in docs/deploy-mainnet.md" } else { "scripts/devnet-reset.sh --new-keys" }
        );
    }

    let signer = frost_signer::FrostSigner::new(cfg.guardian_endpoints()?, &cfg.frost_pubkeys, cfg.guardian_timeout)?;
    let ufvk = zec_wallet::frost::read_ufvk(&cfg.mint_ufvk)?;
    anyhow::ensure!(
        zec_wallet::frost::ufvk_ak(&ufvk)? == signer.group_key()?,
        "{}'s ak is not the guardians' group key ({})",
        cfg.mint_ufvk.display(),
        cfg.frost_pubkeys.display()
    );
    let ufvk = ufvk.encode(&cfg.network.params());
    let mut wallet = Wallet::open_or_import_ufvk(&ufvk, &cfg.mint_db, &cfg.lightwalletd)
        .await
        .with_context(|| format!("cannot open the mint reserve wallet {}", cfg.mint_db.display()))?;
    // Reserve notes below the deposit depth are neither spendable nor counted as spendable.
    wallet.set_min_confirmations(cfg.min_confirmations)?;
    tracing::info!(address = %wallet.address()?, birthday = wallet.birthday()?, "mint reserve wallet (view-only)");
    signer.log_guardians().await;
    let signer = Arc::new(signer);
    let store = store::QuoteStore::open(&cfg.processor_db)?;

    let started = std::time::Instant::now();
    tokio::task::spawn_blocking(zec_wallet::warm_proving_key).await??;
    tracing::info!(elapsed = ?started.elapsed(), "Orchard proving key ready");

    let probe_signer = signer.clone();
    let backend = Arc::new(backend::ZecBackend::new(cfg.clone(), store, wallet, signer));
    backend.start().await?;
    // Guardian health for `/reserves` (the status page): every 20 s.
    let guardian_monitor = backend.reserve_monitor();
    tokio::spawn(async move {
        loop {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let probe = probe_signer.probe(now).await;
            guardian_monitor.record_guardians(probe, now).await;
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        }
    });
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
    anyhow::ensure!(!cfg.mint_ufvk.exists(), "{} already exists; it is the reserve's key: never replace it while funds are held", cfg.mint_ufvk.display());
    let pubkeys: zec_frost::redpallas::keys::PublicKeyPackage = serde_json::from_slice(
        &std::fs::read(&cfg.frost_pubkeys).with_context(|| format!("cannot read {}", cfg.frost_pubkeys.display()))?,
    )?;
    let ufvk = zec_wallet::frost::frost_ufvk(zec_frost::group_key_bytes(&pubkeys)?)?;
    if let Some(dir) = cfg.mint_ufvk.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&cfg.mint_ufvk, ufvk.encode(&cfg.network.params()) + "\n")?;
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
