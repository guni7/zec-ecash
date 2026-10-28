//! Point of sale over NUT-18 payment requests. The server never holds spendable money: each
//! request is P2PK-locked to a fresh key from the payee's phone (`/create?pubkey=`), payments are
//! checked and stored, and the phone collects them (src/locked.rs). Without a pubkey a request
//! is a legacy one, locked to this POS's own key and redeemed into its wallet: devnet only;
//! MAINNET refuses both creating and paying those, so nothing new lands in the POS wallet.
//!
//! Network: the regtest devnet by default; ZEC_NETWORK=mainnet
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
//!   GET  /create?amount=<zat>&unit=zat&pubkey=<hex>[&expires_at=<unix s>][&description=<text>] -> {id, request: "creqA..."}
//!   GET  /check/{id}                    -> {id, amount, received, state, collected, expires_at, expired, cancelled, now}
//!   POST /payment                       <- PaymentRequestPayload (NUT-18)
//!   GET  /requests/{id}/payment, POST /requests/{id}/ack, POST /requests/{id}/cancel,
//!   GET  /keys/{pubkey}/requests (signed; src/locked.rs)
//!   GET  /health                        -> {ok, unit, mint} (the web page's "is it up?")
//!   GET  /judge/status, POST /judge/claim   public judge links, one per browser (src/judge.rs)
//!
//! A request is single-use, locked (nut10 P2PK) to `pubkey`, which is used once; the description
//! (an invoice number, say; at most 64 characters) goes in the request itself. A payment after
//! expires_at, or after the payee cancelled the request (POST /requests/{id}/cancel, signed;
//! src/locked.rs), is refused: 410 "expired: …" / "cancelled: …". Requests without expires_at
//! never expire.
//!
//! Listens on 127.0.0.1:8090 (MAINNET 127.0.0.1:9090, loopback only); the web server proxies
//! https://<host>/pos/* to it, which is also the transport URL in the requests (ZEC_POS_URL).
//! Needs <state>/keys/pos-wallet.seed (`zec-ecash-cli --wallet pos init`); never creates it.
//! Its wallet and request DB live in <state>/pos/ (an older <state>/pos-wallet.redb and
//! pos.sqlite are moved there on start).
//!
//! LEGACY: the POS wallet (requests created before locked payments). Moving its takings out:
//!   pos balance           # what the POS wallet holds
//!   pos sweep [<zat>]     # a token for all of it (or <zat>); also saved, mode 600, in
//!                         # <state>/pos/sweeps/. Receive it in your own wallet, then withdraw.
//! Both talk to the running server over <state>/pos/admin.sock (mode 600, in a mode-700
//! directory), so the server keeps serving; with the server stopped they open the wallet directly.
//! With the server stopped, `zec-ecash-cli --wallet pos withdraw <zat> <address>` works too.
mod judge;
mod locked;

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
    /// Legacy requests' wallet; for locked ones only a mint client (keysets, NUT-07).
    wallet: Wallet,
    key: SecretKey,
    mint: MintUrl,
    pos_url: String,
    db: Mutex<Connection>,
    mainnet: bool,
    /// The judge kit the CLI writes on this host (<state>/judge-kit/kit.json): its public links.
    judge_kit: PathBuf,
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
         -- Proofs accepted for a locked request, by Y (hash_to_curve of the secret): never twice.
         -- Locked payments that lost the race or came after PAID, kept for the payee.
         CREATE TABLE IF NOT EXISTS pos_extra (
             quote_id     TEXT NOT NULL,
             n            INTEGER NOT NULL,
             received     INTEGER NOT NULL,
             token        TEXT,
             proofs       TEXT,
             paid_at      INTEGER NOT NULL,
             collected_at INTEGER,
             PRIMARY KEY (quote_id, n)
         );
         CREATE TABLE IF NOT EXISTS pos_proof (
             y        TEXT PRIMARY KEY,
             quote_id TEXT NOT NULL
         );",
    )?;
    // Extra/partial payments: which kind (added after the table first shipped).
    let has_kind: bool = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('pos_extra') WHERE name = 'kind'", [], |r| r.get::<_, i64>(0))? > 0;
    if !has_kind {
        conn.execute_batch("ALTER TABLE pos_extra ADD COLUMN kind TEXT NOT NULL DEFAULT 'extra';")?;
    }
    // Locked requests: the payee's key, and the stored payment until the payee collects it.
    // Expiry, cancel and description (added later; NULL for older requests: they never expire).
    for (col, ty) in [
        ("pubkey", "TEXT"),
        ("token", "TEXT"),
        ("proofs", "TEXT"),
        ("paid_at", "INTEGER"),
        ("collected_at", "INTEGER"),
        ("expires_at", "INTEGER"),
        ("cancelled_at", "INTEGER"),
        ("description", "TEXT"),
    ] {
        let has: bool = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('pos_quote') WHERE name = ?1", [col], |r| r.get::<_, i64>(0))? > 0;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE pos_quote ADD COLUMN {col} {ty};"))?;
        }
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS pos_quote_pubkey ON pos_quote(pubkey) WHERE pubkey IS NOT NULL;
         -- a crash mid-payment leaves PROCESSING; nothing was claimed or stored yet, so the
         -- payer can retry: go back to UNPAID on start.
         UPDATE pos_quote SET state = 'UNPAID' WHERE state = 'PROCESSING';",
    )?;
    conn.execute_batch(judge::SCHEMA)?;
    let mint = MintUrl::from_str(&cfg.mint_url)?;
    let pos = Arc::new(Pos { wallet, key, mint, pos_url: cfg.pos_url.clone(), db: Mutex::new(conn), mainnet: cfg.network.is_mainnet(), judge_kit: cfg.network.state_dir().join("judge-kit/kit.json") });

    spawn_admin(&cfg, pos.clone()).await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/create", get(create))
        .route("/check/{id}", get(check))
        .route("/payment", post(payment))
        .route("/requests/{id}/payment", get(locked::collect))
        .route("/requests/{id}/ack", post(locked::ack))
        .route("/requests/{id}/cancel", post(locked::cancel))
        .route("/keys/{pubkey}/requests", get(locked::lookup))
        .route("/judge/status", get(judge::status))
        .route("/judge/claim", post(judge::claim))
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
    /// The payee's fresh per-request key (hex, compressed). Required on MAINNET.
    pubkey: Option<String>,
    /// Unix seconds after which payments are refused. None: never expires.
    expires_at: Option<u64>,
    /// Put in the request itself (NUT-18 `d`), e.g. an invoice number.
    description: Option<String>,
}

/// Longest description accepted (characters): it travels in every QR code of the request.
pub const MAX_DESCRIPTION: usize = 64;

/// Checks `/create`'s optional expiry and description.
fn check_create(expires_at: Option<u64>, description: Option<&str>, now: u64) -> Result<(), String> {
    if let Some(t) = expires_at
        && t <= now
    {
        return Err("expires_at is not in the future".into());
    }
    if let Some(d) = description {
        if d.chars().count() > MAX_DESCRIPTION {
            return Err(format!("description is longer than {MAX_DESCRIPTION} characters"));
        }
        if d.chars().any(char::is_control) {
            return Err("description has control characters".into());
        }
    }
    Ok(())
}

/// Why a request takes no more payments, if it doesn't: cancelled (first) or expired.
pub fn closed(expires_at: Option<i64>, cancelled_at: Option<i64>, now: u64) -> Option<Closed> {
    if cancelled_at.is_some() {
        Some(Closed::Cancelled)
    } else if expires_at.is_some_and(|t| now as i64 > t) {
        Some(Closed::Expired)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    Expired,
    Cancelled,
}

impl Closed {
    /// The refusal the payer's wallet shows (starts with "expired:" or "cancelled:").
    pub fn message(self) -> &'static str {
        match self {
            Closed::Expired => "expired: this payment request has expired; ask the shop for a new one",
            Closed::Cancelled => "cancelled: the shop cancelled this payment request; ask for a new one",
        }
    }
}

/// The request's expiry and cancel time.
pub fn closing(conn: &Connection, id: &str) -> rusqlite::Result<(Option<i64>, Option<i64>)> {
    conn.query_row("SELECT expires_at, cancelled_at FROM pos_quote WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
}

async fn create(State(pos): State<Shared>, Query(q): Query<CreateQuery>) -> Response {
    if q.unit.as_deref().is_some_and(|u| !u.eq_ignore_ascii_case(UNIT)) {
        return err(StatusCode::BAD_REQUEST, format!("unsupported unit; this POS only takes {UNIT}"));
    }
    if q.amount == 0 {
        return err(StatusCode::BAD_REQUEST, "amount must be > 0");
    }
    let description = q.description.as_deref().map(str::trim).filter(|d| !d.is_empty());
    if let Err(m) = check_create(q.expires_at, description, now()) {
        return err(StatusCode::BAD_REQUEST, m);
    }
    let payee = match q.pubkey.as_deref().map(PublicKey::from_hex) {
        Some(Ok(k)) => Some(k),
        Some(Err(_)) => return err(StatusCode::BAD_REQUEST, "pubkey is not a compressed secp256k1 public key (hex)"),
        None if pos.mainnet => {
            return err(StatusCode::BAD_REQUEST, "a request needs the payee's pubkey (locked payments only on MAINNET); update the wallet");
        }
        None => None,
    };
    let mut raw = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let id = hex::encode(raw);
    let mut builder = PaymentRequest::builder();
    if let Some(d) = description {
        builder = builder.description(d);
    }
    let request = builder
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
        // Payers must lock the proofs (NUT-10/11 P2PK) to the payee's key; legacy: to this POS's.
        .nut10(Nut10SecretRequest::new(
            Kind::P2PK,
            payee.map(|k| k.to_hex()).unwrap_or_else(|| pos.key.public_key().to_hex()),
            None::<Vec<Vec<String>>>,
        ))
        .build();
    let res = pos.db.lock().unwrap().execute(
        "INSERT INTO pos_quote (id, amount, state, created_at, pubkey, expires_at, description) VALUES (?1, ?2, 'UNPAID', ?3, ?4, ?5, ?6)",
        params![id, q.amount as i64, now() as i64, payee.map(|k| k.to_hex()), q.expires_at.map(|t| t as i64), description],
    );
    match res {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            return err(StatusCode::CONFLICT, "this key was already used for a request; derive a fresh one");
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
    tracing::info!(%id, amount = q.amount, expires_at = ?q.expires_at, "payment request created");
    Json(serde_json::json!({ "id": id, "request": request.to_string() })).into_response()
}

#[derive(Serialize)]
struct QuoteView {
    id: String,
    amount: u64,
    received: u64,
    state: String,
    /// Locked requests: the payee has collected the payment (the server's copy is deleted).
    collected: bool,
    /// Unix seconds; null: never expires.
    expires_at: Option<i64>,
    /// No more payments: past expires_at, or cancelled.
    expired: bool,
    cancelled: bool,
    /// The server's clock (unix seconds), so a payer can tell how long is left without trusting its own.
    now: u64,
}

fn load_quote(conn: &Connection, id: &str) -> rusqlite::Result<Option<QuoteView>> {
    let t = now();
    conn.query_row("SELECT id, amount, received, state, collected_at, expires_at, cancelled_at FROM pos_quote WHERE id = ?1", [id], |r| {
        let (expires_at, cancelled_at): (Option<i64>, Option<i64>) = (r.get(5)?, r.get(6)?);
        let c = closed(expires_at, cancelled_at, t);
        Ok(QuoteView {
            id: r.get(0)?,
            amount: r.get::<_, i64>(1)? as u64,
            received: r.get::<_, i64>(2)? as u64,
            state: r.get(3)?,
            collected: r.get::<_, Option<i64>>(4)?.is_some(),
            expires_at,
            expired: c == Some(Closed::Expired),
            cancelled: c == Some(Closed::Cancelled),
            now: t,
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
    let payee: Option<String> = match pos.db.lock().unwrap().query_row("SELECT pubkey FROM pos_quote WHERE id = ?1", [&id], |r| r.get(0)) {
        Ok(k) => k,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    };
    // Expired or cancelled: refused. Locked: refused, but kept for the payee to refund once it
    // passes the checks, since the payer can no longer spend proofs locked to the payee's key.
    let shut = match closing(&pos.db.lock().unwrap(), &id) {
        Ok((e, c)) => closed(e, c, now()),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    };
    // Locked requests: a late or losing payment becomes an extra payment (src/locked.rs).
    match payee.as_deref().map(PublicKey::from_hex) {
        Some(Ok(key)) => return locked::pay(&pos, &id, quote.amount, &key, p, shut).await,
        Some(Err(e)) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("stored key: {e}")),
        None if pos.mainnet => {
            return err(StatusCode::GONE, "this is a legacy request (paid into the POS's own wallet), not accepted on MAINNET; ask for a new one");
        }
        None => {}
    }
    // LEGACY (devnet): redeem into the POS wallet.
    if let Some(c) = shut {
        return err(StatusCode::GONE, c.message());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_checks_expiry_and_description() {
        assert!(check_create(None, None, 100).is_ok());
        assert!(check_create(Some(101), Some("INV-0001"), 100).is_ok());
        assert!(check_create(Some(100), None, 100).unwrap_err().contains("not in the future"));
        assert!(check_create(None, Some(&"x".repeat(MAX_DESCRIPTION + 1)), 100).unwrap_err().contains("longer"));
        assert!(check_create(None, Some("a\nb"), 100).unwrap_err().contains("control"));
    }

    #[test]
    fn closed_requests() {
        // older requests (no expiry) stay open
        assert_eq!(closed(None, None, u64::MAX / 2), None);
        assert_eq!(closed(Some(100), None, 100), None, "open up to and including expires_at");
        assert_eq!(closed(Some(100), None, 101), Some(Closed::Expired));
        assert_eq!(closed(Some(100), Some(50), 101), Some(Closed::Cancelled), "cancelled wins");
        assert_eq!(closed(None, Some(50), 60), Some(Closed::Cancelled));
        assert!(Closed::Expired.message().starts_with("expired:"));
        assert!(Closed::Cancelled.message().starts_with("cancelled:"));
    }

    /// The schema in a scratch database: old rows (no expiry) read back as open.
    #[test]
    fn closing_reads_the_row() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE pos_quote (id TEXT PRIMARY KEY, amount INTEGER, received INTEGER DEFAULT 0, state TEXT, created_at INTEGER,
               collected_at INTEGER, expires_at INTEGER, cancelled_at INTEGER);
             INSERT INTO pos_quote (id, amount, state, created_at) VALUES ('old', 5, 'UNPAID', 1);
             INSERT INTO pos_quote (id, amount, state, created_at, expires_at) VALUES ('soon', 5, 'UNPAID', 1, 1000);
             INSERT INTO pos_quote (id, amount, state, created_at, cancelled_at) VALUES ('gone', 5, 'UNPAID', 1, 2);",
        )
        .unwrap();
        let at = |id: &str, t: u64| {
            let (e, x) = closing(&c, id).unwrap();
            closed(e, x, t)
        };
        assert_eq!(at("old", 5_000_000_000), None);
        assert_eq!(at("soon", 999), None);
        assert_eq!(at("soon", 1001), Some(Closed::Expired));
        assert_eq!(at("gone", 3), Some(Closed::Cancelled));
        let q = load_quote(&c, "soon").unwrap().unwrap();
        assert_eq!(q.expires_at, Some(1000));
        assert!(q.expired, "now() is far past 1000");
    }
}
