//! Point of sale over NUT-18 payment requests: the regtest devnet by default; ZEC_NETWORK=mainnet
//! for MAINNET (state in mainnet/, settings from mainnet/.env only, port 9090, every log line
//! starts with MAINNET).
//!
//! Ported from thesimplekid/cashu-payment-backend `src/pos_server.rs` (MIT) to cdk 0.18.2, with:
//! - unit `zat` only (the original allowed sat/usd);
//! - the amount check fixed: reject when received < quote amount (the original's was inverted);
//! - the double-spend race fixed: UNPAID -> PROCESSING in one atomic UPDATE before redeeming
//!   (the original checked UNPAID, redeemed, then marked PAID);
//! - each request carries a NUT-10 P2PK lock to this POS's key, and payments must honour it;
//! - only our mint URL is accepted.
//!
//!   GET  /create?amount=<zat>&unit=zat  -> {id, request: "creqA..."}  (single-use, HttpPost transport)
//!   GET  /check/{id}                    -> {id, amount, received, state}
//!   POST /payment                       <- PaymentRequestPayload (NUT-18)
//!   GET  /health                        -> {ok, unit, mint} (the web page's "is it up?")
//!
//! Listens on 127.0.0.1:8090 (MAINNET 127.0.0.1:9090, loopback only); the web server proxies
//! https://<host>/pos/* to it, which is also the transport URL in the requests (ZEC_POS_URL).
//! Needs <state>/keys/pos-wallet.seed (`zec-ecash-cli --wallet pos init`); never creates it.
//! Its wallet and request DB live in <state>/pos/ (an older <state>/pos-wallet.redb and
//! pos.sqlite are moved there on start).
//!
//! Moving the takings out (the wallet only ever fills up):
//!   pos balance           # what the POS wallet holds
//!   pos sweep [<zat>]     # a token for all of it (or <zat>); also saved, mode 600, in
//!                         # <state>/pos/sweeps/. Receive it in your own wallet, then withdraw.
//! Both talk to the running server over <state>/pos/admin.sock (mode 600, in a mode-700
//! directory), so the server keeps serving; with the server stopped they open the wallet directly.
//! With the server stopped, `zec-ecash-cli --wallet pos withdraw <zat> <address>` works too.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, ensure};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cdk::{
    Amount,
    mint_url::MintUrl,
    nuts::{
        CurrencyUnit, Kind, Nut10SecretRequest, PaymentRequest, PaymentRequestPayload, PublicKey, SecretKey,
        SpendingConditions, Transport, TransportType,
    },
    wallet::{ReceiveOptions, SendKind, SendOptions, Wallet},
};
use cdk_common::bitcoin::{
    Network,
    bip32::{ChildNumber, DerivationPath, Xpriv},
};
use cdk_redb::WalletRedbDatabase;
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const UNIT: &str = "zat";
/// A payer's refund locktime must leave us at least this long to redeem.
const MIN_REFUND_LEAD_SECS: u64 = 60;

struct Config {
    network: zec_network::Network,
    listen: String,
    mint_url: String,
    pos_url: String,
    seed: PathBuf,
    /// <state>/pos/: wallet DB, request DB, admin socket, saved sweep tokens.
    dir: PathBuf,
}

fn dotenv(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("export ").unwrap_or(l).split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_matches(|c| c == '"' || c == '\'').to_owned()))
        .collect()
}

fn config() -> Result<Config> {
    let network = zec_network::init()?;
    // MAINNET: only mainnet/.env (the shell may hold the devnet's values from scripts/env.sh).
    let env = if network.is_mainnet() { dotenv(&network.state_dir().join(".env")) } else { dotenv(Path::new(".env")) };
    let get = |k: &str| match network.is_mainnet() {
        true => env.get(k).cloned().filter(|v| !v.is_empty()),
        false => std::env::var(k).ok().filter(|v| !v.is_empty()).or_else(|| env.get(k).cloned()),
    };
    let mint_url = get("ZEC_MINT_URL").with_context(|| {
        if network.is_mainnet() { "ZEC_MINT_URL not set in mainnet/.env" } else { "ZEC_MINT_URL not set (source scripts/env.sh)" }
    })?;
    let pos_url = get("ZEC_POS_URL").unwrap_or_else(|| {
        format!("{}/pos", mint_url.trim_end_matches('/').trim_end_matches("/mint"))
    });
    if let Some(ca) = get("ZEC_MINT_CA") {
        // CDK's HTTP client trusts SSL_CERT_FILE (bitreq's rustls-probe feature); set before any thread.
        // SAFETY: called from main before the runtime starts.
        unsafe { std::env::set_var("SSL_CERT_FILE", ca) };
    }
    let listen = get("ZEC_POS_ADDR").unwrap_or_else(|| format!("127.0.0.1:{}", network.port(8090)));
    if network.is_mainnet() {
        // Only Caddy (same host) may reach it, and the requests must advertise HTTPS URLs.
        let addr: std::net::SocketAddr = listen.parse().with_context(|| format!("ZEC_POS_ADDR {listen} is not ip:port"))?;
        ensure!(addr.ip().is_loopback(), "MAINNET: ZEC_POS_ADDR must be a loopback address (Caddy proxies /pos), not {listen}");
        ensure!(mint_url.starts_with("https://"), "MAINNET: ZEC_MINT_URL must be the mint's public https:// URL, not {mint_url}");
        ensure!(pos_url.starts_with("https://"), "MAINNET: ZEC_POS_URL must be the public https:// URL of /pos, not {pos_url}");
    }
    Ok(Config {
        network,
        listen,
        mint_url,
        pos_url,
        seed: network.state_dir().join("keys/pos-wallet.seed"),
        dir: network.state_dir().join("pos"),
    })
}

/// Same deterministic P2PK path as zec-ecash-cli (CDK's m/129373'/10'/0'/0/0).
fn p2pk_key(seed: &[u8; 64]) -> Result<SecretKey> {
    let path = DerivationPath::from(vec![
        ChildNumber::from_hardened_idx(129373)?,
        ChildNumber::from_hardened_idx(10)?,
        ChildNumber::from_hardened_idx(0)?,
        ChildNumber::from_normal_idx(0)?,
        ChildNumber::from_normal_idx(0)?,
    ]);
    Ok(SecretKey::from(Xpriv::new_master(Network::Bitcoin, seed)?.derive_priv(&cdk::SECP256K1, &path)?.private_key))
}

struct Pos {
    wallet: Wallet,
    key: SecretKey,
    mint: MintUrl,
    pos_url: String,
    db: Mutex<Connection>,
}

type Shared = Arc<Pos>;

fn main() -> Result<()> {
    let cfg = config()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let admin = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => None,
        ["balance"] => Some("balance".to_owned()),
        ["sweep"] => Some("send all".to_owned()),
        ["sweep", zat] => Some(format!("send {}", zat.parse::<u64>().context("sweep takes a whole number of zat")?)),
        _ => anyhow::bail!("usage: pos [balance | sweep [<zat>]]   (no argument: serve)"),
    };
    if cfg.network.is_mainnet() {
        eprintln!("pos: *** MAINNET (real ZEC) *** mint {}", cfg.mint_url);
    }
    devlog::init_labeled(
        &cfg.network.state_dir().join("logs"),
        "pos",
        "info,cdk=warn",
        cfg.network.is_mainnet().then_some("MAINNET "),
    )?;
    let rt = tokio::runtime::Runtime::new()?;
    match admin {
        None => rt.block_on(run(cfg)),
        Some(cmd) => rt.block_on(admin_command(cfg, &cmd)),
    }
}

fn read_seed(cfg: &Config) -> Result<[u8; 64]> {
    ensure!(
        cfg.seed.exists(),
        "{} is missing; create the POS wallet once with `zec-ecash-cli --wallet pos init` (keys are never created implicitly)",
        cfg.seed.display()
    );
    hex::decode(std::fs::read_to_string(&cfg.seed)?.trim())?
        .try_into()
        .map_err(|_| anyhow!("seed must be 64 bytes"))
}

/// Creates <state>/pos/ (mode 700) and moves an older layout's files into it (never deletes).
fn prepare_dir(cfg: &Config) -> Result<()> {
    if !cfg.dir.exists() {
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        b.recursive(true).create(&cfg.dir).with_context(|| format!("cannot create {}", cfg.dir.display()))?;
    }
    for f in ["pos-wallet.redb", "pos.sqlite"] {
        let (old, new) = (cfg.network.state_dir().join(f), cfg.dir.join(f));
        if old.exists() && !new.exists() {
            std::fs::rename(&old, &new).with_context(|| format!("cannot move {} to {}", old.display(), new.display()))?;
            eprintln!("pos: moved {} to {}", old.display(), new.display());
        }
    }
    Ok(())
}

fn open_wallet(cfg: &Config, seed: [u8; 64]) -> Result<Wallet> {
    let db = WalletRedbDatabase::new(&cfg.dir.join("pos-wallet.redb"))
        .with_context(|| format!("cannot open {} (is the POS server running? use `pos sweep`, which asks it)", cfg.dir.join("pos-wallet.redb").display()))?;
    Ok(Wallet::new(&cfg.mint_url, CurrencyUnit::custom(UNIT), Arc::new(db), seed, Some(0))?)
}

async fn run(cfg: Config) -> Result<()> {
    let seed = read_seed(&cfg)?;
    let key = p2pk_key(&seed)?;
    prepare_dir(&cfg)?;
    let wallet = open_wallet(&cfg, seed)?;
    let conn = Connection::open(cfg.dir.join("pos.sqlite"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pos_quote (
             id         TEXT PRIMARY KEY,
             amount     INTEGER NOT NULL,
             received   INTEGER NOT NULL DEFAULT 0,
             state      TEXT NOT NULL CHECK (state IN ('UNPAID', 'PROCESSING', 'PAID')),
             created_at INTEGER NOT NULL
         );
         -- a crash mid-redeem leaves PROCESSING; the proofs are either redeemed or not, so the
         -- payer can retry: go back to UNPAID on start.
         UPDATE pos_quote SET state = 'UNPAID' WHERE state = 'PROCESSING';",
    )?;
    let mint = MintUrl::from_str(&cfg.mint_url)?;
    let pos = Arc::new(Pos { wallet, key, mint, pos_url: cfg.pos_url.clone(), db: Mutex::new(conn) });

    spawn_admin(&cfg, pos.clone()).await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/create", get(create))
        .route("/check/{id}", get(check))
        .route("/payment", post(payment))
        .with_state(pos.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.listen).await.with_context(|| format!("cannot bind {}", cfg.listen))?;
    tracing::info!(listen = %cfg.listen, public = %cfg.pos_url, mint = %cfg.mint_url, pubkey = %pos.key.public_key(), "POS serving");
    eprintln!("pos: {} (public {}), receiver key {}", cfg.listen, cfg.pos_url, pos.key.public_key());
    axum::serve(listener, app).await?;
    Ok(())
}

// ---- admin: balance and sweep over a Unix socket only the service user can open ----

const SOCKET: &str = "admin.sock";

/// Listens on <state>/pos/admin.sock: one line in ("balance" | "send all" | "send <zat>"),
/// one line out ("ok <answer>" | "err <message>").
async fn spawn_admin(cfg: &Config, pos: Shared) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let path = cfg.dir.join(SOCKET);
    if path.exists() {
        ensure!(
            tokio::net::UnixStream::connect(&path).await.is_err(),
            "another POS server is running ({} answers)",
            path.display()
        );
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path).with_context(|| format!("cannot bind {}", path.display()))?;
    #[cfg(unix)]
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    let sweeps = cfg.dir.join("sweeps");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let (pos, sweeps) = (pos.clone(), sweeps.clone());
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut line = String::new();
                if BufReader::new(r).read_line(&mut line).await.is_err() {
                    return;
                }
                let answer = match admin(&pos.wallet, &sweeps, line.trim()).await {
                    Ok(a) => format!("ok {a}\n"),
                    Err(e) => format!("err {e:#}\n"),
                };
                let _ = w.write_all(answer.as_bytes()).await;
            });
        }
    });
    Ok(())
}

async fn admin(wallet: &Wallet, sweeps: &Path, cmd: &str) -> Result<String> {
    let balance = u64::from(wallet.total_balance().await?);
    match cmd.split_whitespace().collect::<Vec<_>>().as_slice() {
        ["balance"] => Ok(balance.to_string()),
        ["send", which] => {
            let zat = if *which == "all" { balance } else { which.parse::<u64>().context("bad amount")? };
            ensure!(zat > 0, "nothing to sweep: the POS wallet is empty");
            ensure!(zat <= balance, "the POS wallet holds {balance} zat, less than {zat}");
            let opts = SendOptions { send_kind: SendKind::OnlineExact, ..Default::default() };
            let token = wallet.prepare_send(Amount::from(zat), opts).await?.confirm(None).await?.to_string();
            // Saved before it is handed out, so a lost terminal never loses the takings.
            let file = sweeps.join(format!("sweep-{}-{zat}zat.token", now()));
            zec_network::write_secret(&file, &format!("{token}\n"))?;
            tracing::info!(zat, file = %file.display(), "swept to a token");
            Ok(format!("{zat} {} {token}", file.display()))
        }
        _ => anyhow::bail!("unknown admin command {cmd:?}"),
    }
}

/// `pos balance` / `pos sweep`: ask the running server; if none, open the wallet directly.
async fn admin_command(cfg: Config, cmd: &str) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let label = cfg.network.label();
    let answer = match tokio::net::UnixStream::connect(cfg.dir.join(SOCKET)).await {
        Ok(stream) => {
            let (r, mut w) = stream.into_split();
            w.write_all(format!("{cmd}\n").as_bytes()).await?;
            let mut line = String::new();
            BufReader::new(r).read_line(&mut line).await?;
            match line.trim_end().split_once(' ') {
                Some(("ok", a)) => a.to_owned(),
                Some(("err", e)) => anyhow::bail!("{e}"),
                _ => anyhow::bail!("unexpected answer from the POS server: {line:?}"),
            }
        }
        Err(_) => {
            eprintln!("pos: server not running; opening the wallet directly");
            prepare_dir(&cfg)?;
            let wallet = open_wallet(&cfg, read_seed(&cfg)?)?;
            admin(&wallet, &cfg.dir.join("sweeps"), cmd).await?
        }
    };
    if cmd == "balance" {
        println!("{label}: the POS wallet holds {answer} zat");
    } else {
        let mut parts = answer.splitn(3, ' ');
        let (zat, file, token) = (parts.next().unwrap_or("?"), parts.next().unwrap_or("?"), parts.next().unwrap_or(""));
        eprintln!("{label}: swept {zat} zat into a token (also saved to {file}, mode 600).");
        eprintln!("Redeem it in your own wallet (`zec-ecash-cli receive <token>`), then withdraw if you like; delete the file after.");
        println!("{token}");
    }
    Ok(())
}

async fn health(State(pos): State<Shared>) -> Response {
    Json(serde_json::json!({ "ok": true, "unit": UNIT, "mint": pos.mint.to_string() })).into_response()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    let msg = msg.into();
    tracing::info!(%status, "{msg}");
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

#[derive(serde::Deserialize)]
struct CreateQuery {
    amount: u64,
    unit: Option<String>,
}

async fn create(State(pos): State<Shared>, Query(q): Query<CreateQuery>) -> Response {
    if q.unit.as_deref().is_some_and(|u| !u.eq_ignore_ascii_case(UNIT)) {
        return err(StatusCode::BAD_REQUEST, format!("unsupported unit; this POS only takes {UNIT}"));
    }
    if q.amount == 0 {
        return err(StatusCode::BAD_REQUEST, "amount must be > 0");
    }
    let mut raw = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let id = hex::encode(raw);
    let request = PaymentRequest::builder()
        .payment_id(id.clone())
        .amount(Amount::from(q.amount))
        .unit(CurrencyUnit::custom(UNIT))
        .single_use(true)
        .add_mint(pos.mint.clone())
        .add_transport(Transport {
            _type: TransportType::HttpPost,
            target: format!("{}/payment", pos.pos_url),
            tags: vec![],
        })
        // Payers must lock the proofs to this POS's key (NUT-10/11 P2PK).
        .nut10(Nut10SecretRequest::new(Kind::P2PK, pos.key.public_key().to_hex(), None::<Vec<Vec<String>>>))
        .build();
    let res = pos.db.lock().unwrap().execute(
        "INSERT INTO pos_quote (id, amount, state, created_at) VALUES (?1, ?2, 'UNPAID', ?3)",
        params![id, q.amount as i64, now() as i64],
    );
    if let Err(e) = res {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"));
    }
    tracing::info!(%id, amount = q.amount, "payment request created");
    Json(serde_json::json!({ "id": id, "request": request.to_string() })).into_response()
}

#[derive(Serialize)]
struct QuoteView {
    id: String,
    amount: u64,
    received: u64,
    state: String,
}

fn load_quote(conn: &Connection, id: &str) -> rusqlite::Result<Option<QuoteView>> {
    conn.query_row("SELECT id, amount, received, state FROM pos_quote WHERE id = ?1", [id], |r| {
        Ok(QuoteView {
            id: r.get(0)?,
            amount: r.get::<_, i64>(1)? as u64,
            received: r.get::<_, i64>(2)? as u64,
            state: r.get(3)?,
        })
    })
    .optional()
}

async fn check(State(pos): State<Shared>, UrlPath(id): UrlPath<String>) -> Response {
    match load_quote(&pos.db.lock().unwrap(), &id) {
        Ok(Some(q)) => Json(q).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "unknown payment request"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
}

/// Everything about a payment that can be checked without touching the quote's state.
fn validate(pos: &Pos, p: &PaymentRequestPayload, quote_amount: u64) -> Result<u64, (StatusCode, String)> {
    let bad = |m: String| (StatusCode::BAD_REQUEST, m);
    if p.mint != pos.mint {
        return Err(bad(format!("wrong mint: this POS only accepts {}", pos.mint)));
    }
    if p.unit != CurrencyUnit::custom(UNIT) {
        return Err(bad(format!("wrong unit: {} (this POS only takes {UNIT})", p.unit)));
    }
    let received: u64 = p.proofs.iter().map(|x| u64::from(x.amount)).sum();
    // The original compared these the wrong way round and accepted underpayments.
    if received < quote_amount {
        return Err(bad(format!("underpayment: received {received} zat, request is for {quote_amount} zat")));
    }
    let ours: PublicKey = pos.key.public_key();
    for (i, proof) in p.proofs.iter().enumerate() {
        match SpendingConditions::try_from(&proof.secret) {
            Ok(SpendingConditions::P2PKConditions { data, conditions }) if data == ours => {
                if let Some(t) = conditions.and_then(|c| c.locktime)
                    && t < now() + MIN_REFUND_LEAD_SECS
                {
                    return Err(bad(format!("proof {i}: refund locktime too soon to redeem safely")));
                }
            }
            _ => return Err(bad(format!("proof {i} is not locked to this POS's key (see the request's nut10)"))),
        }
    }
    Ok(received)
}

async fn payment(State(pos): State<Shared>, Json(p): Json<PaymentRequestPayload>) -> Response {
    let Some(id) = p.id.clone() else {
        return err(StatusCode::BAD_REQUEST, "payment has no request id");
    };
    let quote = match load_quote(&pos.db.lock().unwrap(), &id) {
        Ok(Some(q)) => q,
        Ok(None) => return err(StatusCode::NOT_FOUND, "unknown payment request"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    };
    if quote.state != "UNPAID" {
        return err(StatusCode::CONFLICT, format!("request is already {}", quote.state));
    }
    let received = match validate(&pos, &p, quote.amount) {
        Ok(r) => r,
        Err((s, m)) => return err(s, m),
    };

    // Claim the quote atomically before redeeming: of two concurrent payments only one passes.
    let claimed = pos
        .db
        .lock()
        .unwrap()
        .execute("UPDATE pos_quote SET state = 'PROCESSING' WHERE id = ?1 AND state = 'UNPAID'", [&id]);
    match claimed {
        Ok(1) => {}
        Ok(_) => return err(StatusCode::CONFLICT, "request is already being paid or paid"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }

    let opts = ReceiveOptions { p2pk_signing_keys: vec![pos.key.clone()], ..Default::default() };
    match pos.wallet.receive_proofs(p.proofs, opts, p.memo, None).await {
        Ok(amount) => {
            let _ = pos.db.lock().unwrap().execute(
                "UPDATE pos_quote SET state = 'PAID', received = ?2 WHERE id = ?1 AND state = 'PROCESSING'",
                params![id, u64::from(amount) as i64],
            );
            tracing::info!(%id, received, "PAID");
            Json(serde_json::json!({ "id": id, "state": "PAID", "received": u64::from(amount) })).into_response()
        }
        Err(e) => {
            let _ = pos
                .db
                .lock()
                .unwrap()
                .execute("UPDATE pos_quote SET state = 'UNPAID' WHERE id = ?1 AND state = 'PROCESSING'", [&id]);
            err(StatusCode::BAD_REQUEST, format!("the mint did not accept the proofs: {e}"))
        }
    }
}
