//! "User" wallet for zec-ecash development: the regtest devnet by default; with
//! ZEC_NETWORK=mainnet it works on MAINNET (state in mainnet/, every run says so, and `send`
//! needs --confirm-mainnet).
//!
//!   cargo run -p devwallet -- new                     # create devnet/keys/user-wallet.seed
//!   cargo run -p devwallet -- address                 # print the uregtest1... address
//!   cargo run -p devwallet -- sync                    # scan to the chain tip
//!   cargo run -p devwallet -- balance                 # sync, then spendable/pending per pool
//!   cargo run -p devwallet -- send <address> <zats>   # sync, build, prove, sign, broadcast
//!   cargo run -p devwallet -- tip                     # the light-wallet server's tip height (no wallet)
//!
//! Global flags (before the command):
//!   --seed <path>          default devnet/keys/user-wallet.seed (keys survive resets)
//!   --db <path>            default devnet/<seed name>.sqlite (chain state, deleted by resets),
//!                          so --seed devnet/keys/other.seed is a separate wallet
//!   --ufvk <path>          open a view-only wallet instead, e.g. --ufvk devnet/keys/mint.ufvk
//!                          for the mint reserve (balance/sync/address only; its own DB,
//!                          default devnet/<ufvk name>-view.sqlite, never the processor's)
//!   --lightwalletd <url>   default ZEC_LWD_URL, else http://127.0.0.1:9067 (Zebra's built-in
//!                          gRPC, plaintext) or on mainnet https://zec.rocks:443 (TLS)
//! Paths above are for regtest; on mainnet they are under mainnet/ instead of devnet/.
//!
//! Put the user address in devnet/zebrad-regtest.toml [mining] miner_address so
//! block rewards land in this wallet (spendable after 100 blocks).
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use zec_wallet::{PoolBalance, Wallet};

const USAGE: &str = "usage: devwallet [--seed <path> | --ufvk <path>] [--db <path>] [--lightwalletd <url>] \
                     [--confirm-mainnet] <new|address|sync|balance|send <address> <zats>|tip>   \
                     (run from the zec-ecash folder)";

#[tokio::main]
async fn main() -> Result<()> {
    let network = zec_wallet::network::init()?;
    let dir = network.state_dir();
    if network.is_mainnet() {
        eprintln!("devwallet: *** MAINNET (real ZEC) *** state in {}/", dir.display());
    }
    let mut seed_path = dir.join("keys/user-wallet.seed");
    let mut db_path: Option<PathBuf> = None;
    let mut ufvk_path: Option<PathBuf> = None;
    let mut lightwalletd =
        std::env::var("ZEC_LWD_URL").unwrap_or_else(|_| network.default_lightwalletd().to_owned());
    let mut confirm_mainnet = false;
    let mut cmd = vec![];
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seed" => seed_path = args.next().context("--seed needs a path")?.into(),
            "--db" => db_path = Some(args.next().context("--db needs a path")?.into()),
            "--ufvk" => ufvk_path = Some(args.next().context("--ufvk needs a path")?.into()),
            "--lightwalletd" => lightwalletd = args.next().context("--lightwalletd needs a url")?,
            "--confirm-mainnet" => confirm_mainnet = true,
            _ => cmd.push(arg),
        }
    }
    // Wallet DBs hold chain state, so they live in devnet/ (mainnet/), not next to the seed in keys/.
    let db_path = db_path.unwrap_or_else(|| match &ufvk_path {
        Some(u) => {
            let name = u.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            dir.join(format!("{name}-view.sqlite"))
        }
        None => {
            let name = seed_path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            dir.join(format!("{name}.sqlite"))
        }
    });
    // Same depth as zec-processor when ZEC_MIN_CONFIRMATIONS is set, so `--ufvk` shows the
    // reserve as the processor sees it; otherwise the network default (1 regtest, 10 mainnet).
    let min_confirmations: Option<u32> = match std::env::var("ZEC_MIN_CONFIRMATIONS") {
        Ok(v) => Some(v.trim().parse().context("ZEC_MIN_CONFIRMATIONS must be a whole number")?),
        Err(_) => None,
    };
    let open = || async {
        let mut wallet = match &ufvk_path {
            Some(u) => {
                let ufvk = zec_wallet::frost::read_ufvk(u)?.encode(&network.params());
                Wallet::open_or_import_ufvk(&ufvk, &db_path, &lightwalletd).await
            }
            None => Wallet::open_or_create(&seed_path, &db_path, &lightwalletd).await,
        }?;
        if let Some(n) = min_confirmations {
            wallet.set_min_confirmations(n)?;
        }
        anyhow::Ok(wallet)
    };
    if ufvk_path.is_some() && matches!(cmd.first().map(String::as_str), Some("new" | "send")) {
        bail!("--ufvk wallets are view-only: no `new` or `send`");
    }

    match cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["tip"] => println!("{}", zec_wallet::chain_tip(&lightwalletd).await?),
        ["new"] => {
            zec_wallet::create_seed(&seed_path)?;
            println!("Created {} ({} wallet; keep it out of git)", seed_path.display(), network.label());
            println!("{}", zec_wallet::seed_address(&seed_path)?);
        }
        ["address"] if ufvk_path.is_some() => println!("{}", open().await?.address()?),
        ["address"] => println!("{}", zec_wallet::seed_address(&seed_path)?),
        ["sync"] => {
            let mut wallet = open().await?;
            let tip = wallet.sync().await?;
            println!("{}: synced to height {tip} (birthday {})", network.label(), wallet.birthday()?);
        }
        ["balance"] => {
            let mut wallet = open().await?;
            wallet.sync().await?;
            let b = wallet.balance()?;
            println!("{}: height {} (birthday {})", network.label(), b.height, wallet.birthday()?);
            println!("{:<12} {:>30} {:>30}", "pool", "spendable", "pending");
            for (name, p) in [
                ("Ironwood", b.ironwood),
                ("Orchard", b.orchard),
                ("Sapling", b.sapling),
                ("transparent", b.transparent),
                ("total", b.total()),
            ] {
                println!("{name:<12} {:>30} {:>30}", fmt_zats(p.spendable), fmt_zats(p.pending));
            }
            let PoolBalance { spendable, pending } = b.total();
            println!(
                "spendable = at least {} confirmation(s); pending includes coinbase younger than 100 blocks",
                wallet.min_confirmations()
            );
            if spendable == 0 && pending > 0 && !network.is_mainnet() {
                println!("Nothing spendable yet. Coinbase needs 100 confirmations: ./devnet/mine.sh 110");
            }
        }
        ["send", to, zats] => {
            let zats: u64 = zats.parse().context("<zats> must be a whole number")?;
            if network.is_mainnet() && !confirm_mainnet {
                bail!("MAINNET send of {zats} zat refused: this moves real ZEC. Re-run with --confirm-mainnet if you mean it.");
            }
            let mut wallet = open().await?;
            wallet.sync().await?;
            for txid in wallet.send(to, zats).await? {
                println!("{txid}");
            }
            if network.is_mainnet() {
                eprintln!("MAINNET: broadcast. It confirms in the next blocks (~75 s each); then run balance.");
            } else {
                eprintln!("Broadcast. Confirm it with ./devnet/mine.sh 1, then run balance.");
            }
        }
        _ => bail!(USAGE),
    }
    Ok(())
}

fn fmt_zats(z: u64) -> String {
    format!("{z} ({}.{:08} ZEC)", z / 100_000_000, z % 100_000_000)
}
