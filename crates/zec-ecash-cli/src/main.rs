//! Demo wallet CLI on the CDK wallet crate: the regtest devnet by default; ZEC_NETWORK=mainnet
//! for MAINNET (every run says so; `withdraw` then needs --confirm-mainnet).
//!
//!   zec-ecash-cli init                         # create this wallet's seed (never overwrites)
//!   zec-ecash-cli deposit <zat>                # quote, print address, wait for PAID, mint
//!   zec-ecash-cli mint <quote_id>              # finish an already-paid quote
//!   zec-ecash-cli balance                      # ecash balance in zat
//!   zec-ecash-cli send <zat> [--lock <pubkey>] [--dleq]
//!                                              # cashuB token + terminal QR. Compact (no DLEQ) by
//!                                              # default; --dleq keeps it; --lock (P2PK) always does
//!   zec-ecash-cli check <token>                # offline: DLEQ of every proof vs cached mint keys
//!   zec-ecash-cli pay <creqA...>               # pay a NUT-18 request over its HTTP transport
//!   zec-ecash-cli receive <token>              # redeem a token at the mint
//!   zec-ecash-cli pubkey                       # this wallet's P2PK public key (from its seed)
//!   zec-ecash-cli consolidate                  # swap all proofs into the minimal set
//!   zec-ecash-cli pending                      # tokens you sent that nobody redeemed yet
//!   zec-ecash-cli reclaim <id>                 # take one of those back (voids that token)
//!   zec-ecash-cli withdraw <zat> <uregtest1...>   # melt ecash to a ZEC address
//!   zec-ecash-cli reserves                     # the processor's reserve check: confirmed ZEC
//!                                              # reserve vs. outstanding ecash + in flight
//!
//! Global flags (before the command), each also settable in the environment or `.env`:
//!   --wallet <name>   default "ecash": seed devnet/keys/<name>-wallet.seed (survives resets),
//!                     DB devnet/<name>-wallet.redb (deleted by resets). `--wallet bob` is Bob.
//!   --mint <url>      ZEC_MINT_URL, default http://127.0.0.1:8085 (MAINNET 9085). Must be the exact URL the
//!                     phone uses (tokens carry it), e.g. https://<LAN-IP>:5173/mint
//!   --mint-ca <pem>   ZEC_MINT_CA: extra CA to trust for an https mint URL (e.g. mkcert's
//!                     rootCA.pem). The OS trust store is used too.
//!   ZEC_STATUS_URL    zec-processor's status endpoints (/reserves, /withdrawal-quote); default:
//!                     the mint URL without its /mint suffix (the web proxy serves both there),
//!                     else http://127.0.0.1:8095 (MAINNET 9095).
//! MAINNET: paths are under mainnet/ instead of devnet/, and ZEC_MINT_URL / ZEC_MINT_CA come only
//! from mainnet/.env or the flags, never from the shell (scripts/env.sh exports the devnet's).
//! The seed is never created implicitly: `init` creates it once.
mod tokens;

use std::{
    collections::{HashMap, HashSet},
    future::IntoFuture,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
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

struct Opts {
    network: zec_network::Network,
    /// --confirm-mainnet: allow a MAINNET withdrawal.
    confirm_mainnet: bool,
    wallet: String,
    mint_url: String,
    mint_ca: Option<PathBuf>,
    /// ZEC_MINT_URL was not set (env, .env) and no --mint: using the built-in default.
    mint_url_defaulted: bool,
    cmd: Vec<String>,
}

fn parse_opts() -> Result<Opts> {
    let network = zec_network::init()?;
    let dotenv = tokens::read_dotenv(&network.state_dir().join(".env"));
    let dotenv = if network.is_mainnet() { dotenv } else { tokens::read_dotenv(Path::new(".env")) };
    let env = |k: &str| match network.is_mainnet() {
        // The shell may hold the devnet's values (scripts/env.sh); never use them on mainnet.
        true => dotenv.get(k).cloned(),
        false => std::env::var(k).ok().or_else(|| dotenv.get(k).cloned()),
    };
    let configured_url = env("ZEC_MINT_URL").filter(|v| !v.is_empty());
    let mut o = Opts {
        network,
        confirm_mainnet: false,
        wallet: "ecash".into(),
        mint_url_defaulted: configured_url.is_none(),
        mint_url: configured_url.unwrap_or_else(|| format!("http://127.0.0.1:{}", network.port(8085))),
        mint_ca: env("ZEC_MINT_CA").filter(|v| !v.is_empty()).map(PathBuf::from),
        cmd: vec![],
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--wallet" => o.wallet = args.next().context("--wallet needs a name")?,
            "--mint" => {
                o.mint_url = args.next().context("--mint needs a url")?;
                o.mint_url_defaulted = false;
            }
            "--mint-ca" => o.mint_ca = Some(args.next().context("--mint-ca needs a file")?.into()),
            "--confirm-mainnet" => o.confirm_mainnet = true,
            _ => o.cmd.push(arg),
        }
    }
    ensure!(
        !o.wallet.is_empty() && o.wallet.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "--wallet takes a name like `bob`, not a path"
    );
    Ok(o)
}

fn main() -> Result<()> {
    let opts = parse_opts()?;
    // CDK's HTTP client (bitreq + rustls) trusts the OS store and SSL_CERT_FILE (feature
    // `async-https-rustls-probe`, enabled in Cargo.toml). Set it before any thread or TLS
    // config exists, i.e. before the runtime starts.
    if let Some(ca) = &opts.mint_ca {
        ensure!(ca.exists(), "--mint-ca / ZEC_MINT_CA file {} not found", ca.display());
        if std::env::var_os("SSL_CERT_FILE").is_none() {
            // SAFETY: single-threaded here; no other code reads the environment concurrently.
            unsafe { std::env::set_var("SSL_CERT_FILE", ca) };
        }
    }
    tokio::runtime::Runtime::new()?.block_on(run(opts))
}

async fn run(opts: Opts) -> Result<()> {
    let network = opts.network;
    let dir = network.state_dir();
    // CDK's own log lines go to a size-capped file, not the terminal (devlog crate).
    let _ = devlog::init_labeled(&dir.join("logs"), "cli", "warn", network.is_mainnet().then_some("MAINNET "));
    if network.is_mainnet() {
        eprintln!("zec-ecash-cli: *** MAINNET (real ZEC) *** wallet `{}`, mint {}", opts.wallet, opts.mint_url);
    }
    let seed_path = dir.join(format!("keys/{}-wallet.seed", opts.wallet));
    let db_path = dir.join(format!("{}-wallet", opts.wallet));
    let cmd = opts.cmd;
    if cmd.first().map(String::as_str) == Some("init") {
        return init_seed(&seed_path, network);
    }
    if opts.mint_url_defaulted {
        eprintln!(
            "warning: ZEC_MINT_URL is not set; using {} (tokens from the phone name a different \
             URL and won't match). {}",
            opts.mint_url,
            if network.is_mainnet() {
                "Set it in mainnet/.env or pass --mint."
            } else {
                "Run `source scripts/env.sh` or pass --mint."
            }
        );
    }
    if cmd.first().map(String::as_str) == Some("reserves") {
        return reserves(&opts.mint_url).await;
    }
    let seed = read_seed(&seed_path)?;
    if cmd.first().map(String::as_str) == Some("pubkey") {
        println!("{}", tokens::p2pk_key(&seed)?.public_key());
        return Ok(());
    }
    let wallet = open_wallet(&opts.mint_url, &db_path, seed)
        .with_context(|| format!("wallet `{}` at {}", opts.wallet, opts.mint_url))?;
    // `check` is offline: no keyset refresh, only what the wallet DB has cached.
    if let ["check", token] = cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        let me = tokens::p2pk_key(&seed)?.public_key();
        let results = tokens::check(&wallet, token).await?;
        let mut all_ok = true;
        for (i, r) in results.iter().enumerate() {
            let lock = match &r.lock {
                None => "not locked".to_owned(),
                Some((pk, extra)) => format!(
                    "P2PK-locked to {}{}",
                    if *pk == me { "this wallet".to_owned() } else { pk.to_string() },
                    if *extra { " + extra conditions" } else { "" }
                ),
            };
            match &r.dleq {
                Ok(()) => println!("proof {i}: {:>6} zat  keyset {}  DLEQ pass  {lock}", r.amount, r.keyset),
                Err(e) => {
                    all_ok = false;
                    println!("proof {i}: {:>6} zat  keyset {}  DLEQ FAIL ({e})  {lock}", r.amount, r.keyset)
                }
            }
        }
        let total: u64 = results.iter().map(|r| r.amount).sum();
        if all_ok {
            println!("all {} proofs carry a valid mint signature (offline check): {total} zat", results.len());
            return Ok(());
        }
        bail!("token failed the offline check: don't accept it without redeeming it online");
    }
    sync_keysets(&wallet).await.map_err(|e| {
        let hint = if opts.mint_url_defaulted {
            "\nZEC_MINT_URL is not set, so the default was used. Run `source scripts/env.sh` \
             (or pass --mint <url>)."
        } else if opts.mint_url.starts_with("https") && opts.mint_ca.is_none() {
            "\nFor an https mint with a local CA, set ZEC_MINT_CA (`source scripts/env.sh`)."
        } else {
            ""
        };
        e.context(format!("cannot load keysets from {}{hint}", opts.mint_url))
    })?;
    match cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["deposit", zats] => {
            let zats: u64 = zats.parse().context("<zats> must be a whole number")?;
            let quote = match wallet.mint_quote(PaymentMethod::from(METHOD), Some(Amount::from(zats)), None, None).await {
                Ok(q) => q,
                // The mint reports a refused quote only as "Invalid payment request"; ask the
                // processor why (limits, the reserve check, the reserve cap).
                Err(e) => {
                    let url = format!("{}/deposit-quote?amount={zats}", status_base(&wallet.mint_url.to_string()));
                    match get_status_json(url).await {
                        Ok((_, v)) if v["ok"] == false => bail!(
                            "the mint refused the deposit quote: {}\n(the mint itself only reports: {e})",
                            v["error"].as_str().unwrap_or("?")
                        ),
                        _ => return Err(e.into()),
                    }
                }
            };
            println!("quote {}", quote.id);
            println!("Pay {zats} zat to:\n{}", quote.request);
            if network.is_mainnet() {
                println!("MAINNET: waiting for the deposit to confirm (the mint needs its confirmation depth; ~75 s per block)...");
            } else {
                println!("Waiting for the deposit to confirm (regtest: ./devnet/mine.sh 1 after paying)...");
            }
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
            ensure!(
                !network.is_mainnet() || opts.confirm_mainnet,
                "MAINNET withdrawal of {zats} zat refused: this sends real ZEC. Re-run with --confirm-mainnet if you mean it."
            );
            withdraw(&wallet, zats, address).await?;
        }
        ["send", zats, rest @ ..] => {
            let zats: u64 = zats.parse().context("<zat> must be a whole number")?;
            let mut lock = None;
            // Compact (no DLEQ) is the default for ordinary sends; locked sends always keep DLEQ.
            let mut compact = true;
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match *a {
                    "--lock" => {
                        let pk = it.next().context("--lock needs a P2PK public key (hex)")?;
                        lock = Some(pk.parse().map_err(|e| anyhow::anyhow!("--lock needs a P2PK public key (hex): {e}"))?);
                    }
                    "--compact" => compact = true,
                    "--dleq" => compact = false,
                    _ => bail!("usage: send <zat> [--lock <pubkey>] [--dleq]"),
                }
            }
            let token = tokens::send(&wallet, zats, lock, compact).await?;
            println!("{token}");
            tokens::print_qr(&token);
            println!("sent {zats} zat{}; balance {} zat", if lock.is_some() { " (P2PK-locked)" } else { "" }, u64::from(wallet.total_balance().await?));
        }
        ["receive", token] => {
            let received = tokens::receive(&wallet, &seed, token).await?;
            println!("received {received} zat (redeemed at mint)");
            println!("balance {} zat", u64::from(wallet.total_balance().await?));
        }
        ["pay", request, rest @ ..] => {
            let mut amount = None;
            let mut refund_after = 900;
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match *a {
                    "--amount" => amount = Some(it.next().context("--amount <zat>")?.parse().context("--amount must be a number")?),
                    "--refund-after" => refund_after = it.next().context("--refund-after <secs>")?.parse().context("--refund-after must be seconds")?,
                    _ => bail!("usage: pay <creqA...> [--amount <zat>] [--refund-after <secs>]"),
                }
            }
            let paid = tokens::pay(&wallet, &seed, request, amount, refund_after).await?;
            if (200..300).contains(&paid.status) {
                println!("paid {} zat to {}: {}", paid.amount, paid.target, paid.body);
            } else {
                println!("payment refused ({}): {}", paid.status, paid.body);
                if let Some(at) = paid.refund_at {
                    println!(
                        "Your {} zat are locked to the receiver with a refund to you after unix time {at}; \
                         recover them then with: zec-ecash-cli receive <token>",
                        paid.amount
                    );
                }
                println!("token: {}", paid.token);
                bail!("not paid");
            }
        }
        ["pending"] => {
            let sends = tokens::pending_sends(&wallet).await?;
            if sends.is_empty() {
                println!("no unredeemed tokens");
            }
            for (id, amount, created, token) in sends {
                println!("{id}  {amount} zat  created {created}\n  {token}");
            }
        }
        ["reclaim", id] => {
            let amount = tokens::reclaim(&wallet, id).await?;
            println!("reclaimed {amount} zat; balance {} zat", u64::from(wallet.total_balance().await?));
        }
        ["consolidate"] => {
            let (before, after, total) = tokens::consolidate(&wallet).await?;
            println!("{before} proofs -> {after} proofs; balance {total} zat");
        }
        ["balance"] => println!("{} zat", u64::from(wallet.total_balance().await?)),
        _ => bail!(
            "usage: zec-ecash-cli [--wallet <name>] [--mint <url>] [--mint-ca <pem>] \
             <init|deposit <zat>|mint <quote_id>|send <zat> [--lock <pubkey>] [--dleq]|receive <token>|check <token>|\
             pubkey|pay <creqA>|consolidate|pending|reclaim <id>|withdraw <zat> <address>|balance|reserves>"
        ),
    }
    Ok(())
}

/// Melts `zats` of ecash into a ZEC payment to `address` and waits until the mint reports the
/// Base URL of zec-processor's status endpoints (see ZEC_STATUS_URL in the header).
fn status_base(mint_url: &str) -> String {
    match std::env::var("ZEC_STATUS_URL") {
        Ok(u) => u.trim_end_matches('/').to_owned(),
        Err(_) => match mint_url.trim_end_matches('/').strip_suffix("/mint") {
            Some(origin) => origin.to_owned(),
            None => format!("http://127.0.0.1:{}", zec_network::current().port(8095)),
        },
    }
}

/// GET a status endpoint's JSON (any HTTP status: the body says what happened).
async fn get_status_json(url: String) -> Result<(String, serde_json::Value)> {
    let resp = bitreq::get(url.as_str())
        .with_timeout(15)
        .send_async()
        .await
        .map_err(|e| anyhow::anyhow!("cannot reach {url}: {e} (is zec-processor running?)"))?;
    let v = serde_json::from_str(resp.as_str().unwrap_or(""))
        .with_context(|| format!("{url} answered {} without JSON", resp.status_code))?;
    Ok((url, v))
}

async fn fetch_reserves(mint_url: &str) -> Result<(String, serde_json::Value)> {
    get_status_json(format!("{}/reserves", status_base(mint_url))).await
}

/// Asks the processor why a withdrawal can't be quoted (the mint only says "Unit
/// unsupported"). `None` if it can be, or if the processor can't be asked.
async fn withdrawal_refusal(mint_url: &str, zats: u64, address: &str) -> Option<String> {
    let address: String = address
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let url = format!("{}/withdrawal-quote?amount={zats}&address={address}", status_base(mint_url));
    match get_status_json(url).await {
        Ok((_, v)) if v["ok"] == false => v["error"].as_str().map(str::to_owned),
        _ => None,
    }
}

/// Prints the processor's latest reserve check; fails (exit 1) if it is violated or unknown.
async fn reserves(mint_url: &str) -> Result<()> {
    let (_, v) = fetch_reserves(mint_url).await?;
    let n = |k: &str| v[k].as_u64().unwrap_or(0);
    let state = v["state"].as_str().unwrap_or("?");
    if state == "unknown" {
        bail!("no reserve check has completed yet ({})", v["error"].as_str().unwrap_or("processor just started"));
    }
    let age = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        .saturating_sub(n("checked_at"));
    let l = &v["ledger"];
    println!(
        "reserve check: {}   (chain height {}, depth {}, checked {age} s ago)",
        match state {
            "ok" => "OK",
            "operator_action_required" => "OK, but OPERATOR ACTION NEEDED",
            _ => "VIOLATED",
        },
        n("chain_height"),
        n("min_confirmations")
    );
    println!("confirmed reserve        {:>14} zat", n("reserve_zats"));
    println!("outstanding + in flight  {:>14} zat", n("required_zats"));
    println!(
        "  outstanding ecash      {:>14} zat   (issued {} - redeemed {} - melting {})",
        n("outstanding_zats"),
        l["issued"].as_u64().unwrap_or(0),
        l["redeemed"].as_u64().unwrap_or(0),
        l["pending_melt"].as_u64().unwrap_or(0)
    );
    println!("  withdrawals in flight  {:>14} zat", n("in_flight_zats"));
    if let Some(e) = v["error"].as_str() {
        println!("latest check could not run: {e}");
    }
    let actions = v["operator_action"].as_array().cloned().unwrap_or_default();
    for a in &actions {
        println!(
            "OPERATOR ACTION NEEDED: withdrawal {} ({} zat to {}): {}",
            a["quote_id"].as_str().unwrap_or("?"),
            a["amount_zats"].as_u64().unwrap_or(0),
            a["address"].as_str().unwrap_or("?"),
            a["reason"].as_str().unwrap_or("?")
        );
    }
    if !actions.is_empty() {
        println!("(after dealing with one: zec-processor resolve <quote_id>)");
    }
    if state == "ok" || state == "operator_action_required" {
        println!("surplus                  {:>14} zat", n("reserve_zats") - n("required_zats"));
        ensure!(actions.is_empty(), "{} withdrawal(s) need an operator", actions.len());
        Ok(())
    } else {
        bail!("reserve short by {} zat: the mint refuses new deposit quotes until it is restored", n("shortfall_zats"))
    }
}

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
    // CDK says only "Insufficient funds", which reads like the mint's reserve; this is the
    // wallet's own ecash.
    let needed = u64::from(quote.amount) + u64::from(quote.fee_reserve);
    let have = u64::from(wallet.total_balance().await?);
    ensure!(
        have >= needed,
        "not enough ecash in this wallet: it holds {have} zat, and this withdrawal needs {needed} zat \
         ({} zat + {} zat fee reserve; unused fee reserve comes back as change)",
        u64::from(quote.amount),
        u64::from(quote.fee_reserve)
    );
    let prepared = wallet.prepare_melt(&quote.id, HashMap::new()).await?;
    let finalized = match prepared.confirm_prefer_async().await? {
        MeltOutcome::Paid(done) => done,
        MeltOutcome::Pending(pending) => {
            println!("Pending: the transaction is being built and broadcast; waiting for it to be mined");
            if zec_network::current().is_mainnet() {
                println!("(MAINNET: ~75 s per block)...");
            } else {
                println!("(regtest: ./devnet/mine.sh 1)...");
            }
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
    let resp = match HttpClient::new(wallet.mint_url.clone(), None).post_melt_quote(MeltQuoteRequest::Custom(request)).await {
        Ok(r) => r,
        // cdk-mintd 0.18.2 answers every failed `zec` quote with "Unit unsupported"; ask the
        // processor for the real reason.
        Err(e) => match withdrawal_refusal(&wallet.mint_url.to_string(), zats, address).await {
            Some(reason) => bail!("the mint refused the withdrawal quote: {reason}\n(the mint itself only reports: {e})"),
            None => return Err(anyhow::Error::new(e).context("the mint refused the withdrawal quote")),
        },
    };
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

/// `init`: creates the wallet seed (64 random bytes, hex). Refuses to overwrite one.
fn init_seed(seed_path: &Path, network: zec_network::Network) -> Result<()> {
    if seed_path.exists() {
        bail!("{} already exists; delete it first if you really want a new ecash wallet", seed_path.display());
    }
    let mut seed = [0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    if let Some(dir) = seed_path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(seed_path, hex::encode(seed))?;
    println!("Created {} ({} wallet; keep it out of git)", seed_path.display(), network.label());
    Ok(())
}

/// Reads the wallet seed, which must exist (never created implicitly).
fn read_seed(seed_path: &Path) -> Result<[u8; 64]> {
    ensure!(
        seed_path.exists(),
        "{} is missing. The ecash wallet seed is never created implicitly: restore it, or run \
         `zec-ecash-cli [--wallet <name>] init` for a new (empty) wallet",
        seed_path.display()
    );
    hex::decode(fs::read_to_string(seed_path)?.trim())
        .context("seed file is not hex")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("seed file must hold 64 bytes"))
}

/// Opens the CDK wallet at `<path>.redb`.
fn open_wallet(mint_url: &str, path: &Path, seed: [u8; 64]) -> Result<Wallet> {
    let db = WalletRedbDatabase::new(&path.with_extension("redb"))?;
    // target_proof_count 0: no "keep N proofs of every denomination" refill. cdk's default (3)
    // turned a 50,000 zat mint into 48 proofs; with 0 every mint, swap, receive and send splits
    // amounts into the minimal powers of two (SplitTarget::None -> Amount::split).
    Ok(Wallet::new(mint_url, CurrencyUnit::custom(UNIT), Arc::new(db), seed, Some(0))?)
}
