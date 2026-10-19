//! Point of sale over NUT-18 payment requests (regtest devnet; NOT for real funds).
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
//!
//! Listens on 127.0.0.1:8090; the web dev server proxies https://<host>:5173/pos/* to it, which is
//! also the transport URL in the requests. Needs devnet/keys/pos-wallet.seed
//! (`zec-ecash-cli --wallet pos init`); never creates it.
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
    wallet::{ReceiveOptions, Wallet},
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
    listen: String,
    mint_url: String,
    pos_url: String,
    seed: PathBuf,
}

fn dotenv() -> HashMap<String, String> {
    std::fs::read_to_string(".env")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("export ").unwrap_or(l).split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_matches(|c| c == '"' || c == '\'').to_owned()))
        .collect()
}

fn config() -> Result<Config> {
    let env = dotenv();
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).or_else(|| env.get(k).cloned());
    let mint_url = get("ZEC_MINT_URL").context("ZEC_MINT_URL not set (source scripts/env.sh)")?;
    let pos_url = get("ZEC_POS_URL").unwrap_or_else(|| {
        format!("{}/pos", mint_url.trim_end_matches('/').trim_end_matches("/mint"))
    });
    if let Some(ca) = get("ZEC_MINT_CA") {
        // CDK's HTTP client trusts SSL_CERT_FILE (bitreq's rustls-probe feature); set before any thread.
        // SAFETY: called from main before the runtime starts.
        unsafe { std::env::set_var("SSL_CERT_FILE", ca) };
    }
    Ok(Config {
        listen: get("ZEC_POS_ADDR").unwrap_or_else(|| "127.0.0.1:8090".into()),
        mint_url,
        pos_url,
        seed: PathBuf::from("devnet/keys/pos-wallet.seed"),
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
    devlog::init(Path::new("devnet/logs"), "pos", "info,cdk=warn")?;
    tokio::runtime::Runtime::new()?.block_on(run(cfg))
}

async fn run(cfg: Config) -> Result<()> {
    ensure!(
        cfg.seed.exists(),
        "{} is missing; create the POS wallet once with `zec-ecash-cli --wallet pos init` (keys are never created implicitly)",
        cfg.seed.display()
    );
    let seed: [u8; 64] = hex::decode(std::fs::read_to_string(&cfg.seed)?.trim())?
        .try_into()
        .map_err(|_| anyhow!("seed must be 64 bytes"))?;
    let key = p2pk_key(&seed)?;
    let db = WalletRedbDatabase::new(Path::new("devnet/pos-wallet.redb"))?;
    let wallet = Wallet::new(&cfg.mint_url, CurrencyUnit::custom(UNIT), Arc::new(db), seed, Some(0))?;
    let conn = Connection::open("devnet/pos.sqlite")?;
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

    let app = Router::new()
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
