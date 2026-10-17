//! Demo wallet CLI on the CDK wallet crate (regtest devnet; NOT for real funds).
//!
//!   cargo run -p zec-ecash-cli -- deposit <zats>   # quote, print address, wait for PAID, mint
//!   cargo run -p zec-ecash-cli -- mint <quote_id>  # finish an already-paid quote
//!   cargo run -p zec-ecash-cli -- balance          # ecash balance in zat
//!   cargo run -p zec-ecash-cli -- withdraw <zats> <uregtest1...>   # melt ecash to a ZEC address
//!
//! Flags (before the command): --mint <url> (default http://127.0.0.1:8085),
//! --wallet <path> (default devnet/ecash-wallet; uses <path>.seed and <path>.redb).
//! Pay the printed address from any wallet, e.g. `devwallet send <address> <zats>`, and
//! mine a block on regtest (`./devnet/mine.sh 1`); the tokens are minted automatically.
use std::{
    collections::{HashMap, HashSet},
    future::IntoFuture,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use cdk::{
    Amount, MeltQuoteCreateResponse, MeltQuoteRequest,
    amount::SplitTarget,
    nuts::{CurrencyUnit, Id, KeySetInfo, MeltQuoteCustomRequest, MeltQuoteState, PaymentMethod},
    wallet::{
        HttpClient, MeltOutcome, MintConnector, Wallet,
        types::{KeysetLoadPolicy, MeltQuote},
    },
};
use cdk_redb::WalletRedbDatabase;
use rand::RngCore;

const METHOD: &str = "zec";
/// The mint's keyset unit. `CurrencyUnit::custom` lowercases, so this must match the mint's
/// `[payment_backend] unit` exactly; every unit the CLI uses comes from here.
const UNIT: &str = "zat";
/// NUT-20 key indexes to try when re-deriving the signing key of a quote not stored locally.
const QUOTE_KEY_SEARCH: u32 = 1000;
/// How often a waiting `withdraw` asks the mint for the melt quote's status.
const STATUS_POLL: Duration = Duration::from_secs(15);
/// How long `deposit` waits for the payment to confirm (the mint quote lives for an hour).
const DEPOSIT_WAIT: Duration = Duration::from_secs(3600);

#[tokio::main]
async fn main() -> Result<()> {
    let mut mint_url = "http://127.0.0.1:8085".to_owned();
    let mut wallet_path = PathBuf::from("devnet/ecash-wallet");
    let mut cmd = vec![];
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mint" => mint_url = args.next().context("--mint needs a url")?,
            "--wallet" => wallet_path = args.next().context("--wallet needs a path")?.into(),
            _ => cmd.push(arg),
        }
    }

    let wallet = open_wallet(&mint_url, &wallet_path)?;
    sync_keysets(&wallet).await?;
    match cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["deposit", zats] => {
            let zats: u64 = zats.parse().context("<zats> must be a whole number")?;
            let quote = wallet
                .mint_quote(PaymentMethod::from(METHOD), Some(Amount::from(zats)), None, None)
                .await?;
            println!("quote {}", quote.id);
            println!("Pay {zats} zat to:\n{}", quote.request);
            println!("Waiting for the deposit to confirm (regtest: ./devnet/mine.sh 1 after paying)...");
            let proofs = wallet
                .wait_and_mint_quote(quote, SplitTarget::default(), None, DEPOSIT_WAIT)
                .await
                .context("deposit was not minted")?;
            let minted: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
            println!("Minted {minted} zat in {} proofs", proofs.len());
            println!("balance {} zat", u64::from(wallet.total_balance().await?));
        }
        ["mint", quote_id] => {
            // Works for quotes this wallet no longer has locally (e.g. after a DB reset):
            // fetch from the mint, and re-derive the quote's NUT-20 signing key from the seed.
            let quote = wallet
                .fetch_mint_quote_with_key_search(quote_id, Some(PaymentMethod::from(METHOD)), QUOTE_KEY_SEARCH)
                .await
                .context("cannot fetch the quote from the mint")?;
            println!(
                "quote {}: {} (paid {} zat, issued {} zat)",
                quote.id,
                quote.state,
                u64::from(quote.amount_paid),
                u64::from(quote.amount_issued)
            );
            if quote.amount_mintable() == Amount::ZERO {
                bail!("nothing to mint: the quote is not paid yet or already issued");
            }
            let proofs = wallet.mint(&quote.id, SplitTarget::default(), None).await?;
            let minted: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
            println!("Minted {minted} zat in {} proofs", proofs.len());
            println!("balance {} zat", u64::from(wallet.total_balance().await?));
        }
        ["withdraw", zats, address] => {
            let zats: u64 = zats.parse().context("<zats> must be a whole number")?;
            withdraw(&wallet, zats, address).await?;
        }
        ["balance"] => println!("{} zat", u64::from(wallet.total_balance().await?)),
        _ => bail!(
            "usage: zec-ecash-cli [--mint <url>] [--wallet <path>] \
             <deposit <zats>|mint <quote_id>|withdraw <zats> <address>|balance>"
        ),
    }
    Ok(())
}

/// Melts `zats` of ecash into a ZEC payment to `address` and waits until the mint reports the
/// withdrawal PAID (mined) or FAILED.
async fn withdraw(wallet: &Wallet, zats: u64, address: &str) -> Result<()> {
    let quote = melt_quote(wallet, zats, address).await?;
    println!(
        "quote {}: send {} zat, fee reserve {} zat (total {} zat of ecash)",
        quote.id,
        u64::from(quote.amount),
        u64::from(quote.fee_reserve),
        u64::from(quote.amount) + u64::from(quote.fee_reserve)
    );
    let prepared = wallet.prepare_melt(&quote.id, HashMap::new()).await?;
    let finalized = match prepared.confirm_prefer_async().await? {
        MeltOutcome::Paid(done) => done,
        MeltOutcome::Pending(pending) => {
            println!("Pending: the transaction is being built and broadcast; waiting for it to be mined");
            println!("(regtest: ./devnet/mine.sh 1)...");
            // Also ask the mint for the quote's status now and then: a status request makes the
            // mint check with zec-processor, which settles the melt even if a push was missed.
            let nudge = HttpClient::new(wallet.mint_url.clone(), None);
            let done = pending.into_future();
            tokio::pin!(done);
            loop {
                tokio::select! {
                    finalized = &mut done => break finalized?,
                    _ = tokio::time::sleep(STATUS_POLL) => {
                        let _ = nudge.get_melt_quote_status(PaymentMethod::from(METHOD), &quote.id).await;
                    }
                }
            }
        }
    };
    println!("state {}", finalized.state());
    if finalized.state() != MeltQuoteState::Paid {
        bail!("withdrawal {} did not complete; the ecash was returned to the wallet", quote.id);
    }
    println!("txid {}", finalized.payment_proof().unwrap_or("?"));
    println!(
        "sent {} zat, fee {} zat, change returned {} zat",
        u64::from(finalized.amount()),
        u64::from(finalized.fee_paid()),
        finalized.change().map(|c| c.iter().map(|p| u64::from(p.amount)).sum::<u64>()).unwrap_or(0)
    );
    println!("balance {} zat", u64::from(wallet.total_balance().await?));
    Ok(())
}

/// Requests a `zec` melt quote with an amount. CDK's `Wallet::melt_quote` can't do this for
/// custom methods (0.18.2 always sends `amount: None`), so post it directly and store the
/// quote the way `melt_quote_custom` does, so `prepare_melt` can use it.
async fn melt_quote(wallet: &Wallet, zats: u64, address: &str) -> Result<MeltQuote> {
    let request = MeltQuoteCustomRequest {
        method: METHOD.to_owned(),
        request: address.to_owned(),
        unit: CurrencyUnit::custom(UNIT),
        amount: Some(Amount::from(zats)),
        extra: serde_json::Value::Null,
    };
    let resp = HttpClient::new(wallet.mint_url.clone(), None)
        .post_melt_quote(MeltQuoteRequest::Custom(request))
        .await
        .context("the mint refused the withdrawal quote")?;
    let MeltQuoteCreateResponse::Custom((_, resp)) = resp else {
        bail!("unexpected melt quote response type");
    };
    let quote = MeltQuote {
        id: resp.quote,
        mint_url: Some(wallet.mint_url.clone()),
        amount: resp.amount,
        request: resp.request.unwrap_or_else(|| address.to_owned()),
        unit: wallet.unit.clone(),
        fee_reserve: resp.fee_reserve.unwrap_or_default(),
        state: resp.state,
        expiry: resp.expiry,
        payment_proof: resp.payment_preimage,
        estimated_blocks: None,
        fee_index: None,
        payment_method: PaymentMethod::from(METHOD),
        used_by_operation: None,
        version: 0,
    };
    wallet.localstore.add_melt_quote(quote.clone()).await?;
    Ok(quote)
}

/// Compares the wallet's cached keysets with the mint's `/v1/keysets` on every start.
///
/// Mints keep listing retired keysets (as inactive), so a cached keyset the mint doesn't list
/// means this URL now serves a different mint database. CDK merges fetched keysets into its
/// cache instead of replacing it, so such a keyset would stay "active" and could be picked for
/// new outputs, which the mint rejects with "Unknown Keyset". This marks those keysets inactive,
/// refreshes from the mint, and reports the proofs stranded in them (unspendable at this mint).
/// If the mint is unreachable, the cache is used as is, so `balance` still works offline.
async fn sync_keysets(wallet: &Wallet) -> Result<()> {
    let cached: Vec<KeySetInfo> = wallet
        .localstore
        .get_mint_keysets(wallet.mint_url.clone())
        .await?
        .unwrap_or_default();
    let mint_ids: HashSet<Id> = match HttpClient::new(wallet.mint_url.clone(), None)
        .get_mint_keysets()
        .await
    {
        Ok(resp) => resp.keysets.into_iter().map(|k| k.id).collect(),
        Err(e) if cached.is_empty() => return Err(e).context("cannot load keysets from the mint"),
        Err(e) => {
            eprintln!("warning: could not check keysets with the mint ({e}); using cached ones");
            return Ok(());
        }
    };

    let stale: Vec<KeySetInfo> = cached.into_iter().filter(|k| !mint_ids.contains(&k.id)).collect();
    if !stale.is_empty() {
        let stale_ids: HashSet<Id> = stale.iter().map(|k| k.id).collect();
        let stranded: u64 = wallet
            .get_unspent_proofs()
            .await?
            .iter()
            .filter(|p| stale_ids.contains(&p.keyset_id))
            .map(|p| u64::from(p.amount))
            .sum();
        let retired = stale.into_iter().map(|k| KeySetInfo { active: false, ..k }).collect();
        wallet.localstore.add_mint_keysets(wallet.mint_url.clone(), retired).await?;
        eprintln!(
            "warning: {} cached keyset(s) are unknown to {} (a different mint database at this \
             URL?). Marked them inactive; {stranded} zat of proofs in them can't be spent here.",
            stale_ids.len(),
            wallet.mint_url
        );
    }
    wallet.keysets(KeysetLoadPolicy::Refresh).await?;
    Ok(())
}

/// Opens the CDK wallet at `<path>.redb`, creating `<path>.seed` (64 random bytes, hex) on
/// first use.
fn open_wallet(mint_url: &str, path: &Path) -> Result<Wallet> {
    let seed_path = path.with_extension("seed");
    if !seed_path.exists() {
        let mut seed = [0u8; 64];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        if let Some(dir) = seed_path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&seed_path, hex::encode(seed))?;
        eprintln!("Created {} (devnet only, keep it out of git)", seed_path.display());
    }
    let seed: [u8; 64] = hex::decode(fs::read_to_string(&seed_path)?.trim())
        .context("seed file is not hex")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("seed file must hold 64 bytes"))?;
    let db = WalletRedbDatabase::new(&path.with_extension("redb"))?;
    Ok(Wallet::new(mint_url, CurrencyUnit::custom(UNIT), Arc::new(db), seed, None)?)
}
