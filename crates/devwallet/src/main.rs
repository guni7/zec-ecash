//! Local regtest "user" wallet for zec-ecash development. NOT for real funds.
//!
//!   cargo run -p devwallet -- new                     # create devnet/user-wallet.seed
//!   cargo run -p devwallet -- address                 # print the uregtest1... address
//!   cargo run -p devwallet -- sync                    # scan to the chain tip
//!   cargo run -p devwallet -- balance                 # sync, then spendable/pending per pool
//!   cargo run -p devwallet -- send <address> <zats>   # sync, build, prove, sign, broadcast
//!
//! Global flags (before the command):
//!   --seed <path>          default devnet/user-wallet.seed; the DB is the same path with
//!                          .sqlite, so --seed devnet/mint-wallet.seed is a separate wallet
//!   --lightwalletd <url>   default http://127.0.0.1:9067 (Zebra's built-in gRPC, plaintext)
//!
//! Put the user address in devnet/zebrad-regtest.toml [mining] miner_address so
//! block rewards land in this wallet (spendable after 100 blocks).
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use zec_wallet::{PoolBalance, Wallet};

const USAGE: &str = "usage: devwallet [--seed <path>] [--lightwalletd <url>] \
                     <new|address|sync|balance|send <address> <zats>>   (run from the zec-ecash folder)";

#[tokio::main]
async fn main() -> Result<()> {
    let mut seed_path = PathBuf::from("devnet/user-wallet.seed");
    let mut lightwalletd = "http://127.0.0.1:9067".to_owned();
    let mut cmd = vec![];
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seed" => seed_path = args.next().context("--seed needs a path")?.into(),
            "--lightwalletd" => lightwalletd = args.next().context("--lightwalletd needs a url")?,
            _ => cmd.push(arg),
        }
    }
    let db_path = seed_path.with_extension("sqlite");
    let open = || Wallet::open_or_create(&seed_path, &db_path, &lightwalletd);

    match cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["new"] => {
            zec_wallet::create_seed(&seed_path)?;
            println!("Created {} (regtest only, keep it out of git)", seed_path.display());
            println!("{}", zec_wallet::seed_address(&seed_path)?);
        }
        ["address"] => println!("{}", zec_wallet::seed_address(&seed_path)?),
        ["sync"] => println!("synced to height {}", open().await?.sync().await?),
        ["balance"] => {
            let mut wallet = open().await?;
            wallet.sync().await?;
            let b = wallet.balance()?;
            println!("height {}", b.height);
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
            if spendable == 0 && pending > 0 {
                println!("Nothing spendable yet. Coinbase needs 100 confirmations: ./devnet/mine.sh 110");
            }
        }
        ["send", to, zats] => {
            let zats: u64 = zats.parse().context("<zats> must be a whole number")?;
            let mut wallet = open().await?;
            wallet.sync().await?;
            for txid in wallet.send(to, zats).await? {
                println!("{txid}");
            }
            eprintln!("Broadcast. Confirm it with ./devnet/mine.sh 1, then run balance.");
        }
        _ => bail!(USAGE),
    }
    Ok(())
}

fn fmt_zats(z: u64) -> String {
    format!("{z} ({}.{:08} ZEC)", z / 100_000_000, z % 100_000_000)
}
