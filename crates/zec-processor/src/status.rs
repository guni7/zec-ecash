//! Plain-HTTP status endpoints (loopback; the web proxy exposes them over HTTPS):
//! - `GET /reserves`: the reserve check (see `reserves`).
//! - `GET /deposit-quote?amount=<zat>`: whether a deposit quote would be accepted (limits, the
//!   reserve check, the ZEC_MAX_RESERVE cap), and if not, why.
//! - `GET /deposit-quote?quote=<id>`: an open deposit's progress (zat received, confirmations
//!   so far and needed), for a wallet's confirmation bar. Quote ids are unguessable.
//!   `/reserves` also lists whether each guardian answers (`guardians`; no addresses).
//! - `GET /withdrawal-quote?amount=<zat>&address=<ua>`: whether a withdrawal can be quoted, and
//!   if not, why. cdk-mintd 0.18.2 reports every failed `zec` melt quote to the wallet as "Unit
//!   unsupported" (and its gRPC server drops our message before that), so wallets ask here.
use std::{net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    backend::ZecBackend,
    reserves::{DepositRefusal, ReserveMonitor},
    withdraw::QuoteRefusal,
};

#[derive(Clone)]
struct AppState {
    monitor: ReserveMonitor,
    backend: Arc<ZecBackend>,
}

async fn reserves(State(s): State<AppState>) -> impl IntoResponse {
    s.monitor.report().await
}

#[derive(Deserialize)]
struct QuoteQuery {
    amount: u64,
    address: String,
}

#[derive(Deserialize)]
struct DepositQuery {
    amount: Option<u64>,
    quote: Option<String>,
}

/// `?amount=`: 200 `{"ok":true,"amount"}`, or 422 `{"ok":false,"code","error",...}`.
/// `?quote=`: 200 with the quote's progress, or 404.
async fn deposit_quote(State(s): State<AppState>, Query(q): Query<DepositQuery>) -> impl IntoResponse {
    if let Some(id) = q.quote.as_deref() {
        return match s.backend.deposit_progress(id.trim()) {
            Ok(Some((quote, required))) => (StatusCode::OK, Json(progress_json(&quote, required))),
            Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "ok": false, "code": "unknown_quote", "error": "no such deposit quote" }))),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "ok": false, "code": "check_failed", "error": format!("{e:#}") }))),
        };
    }
    let Some(amount) = q.amount else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "code": "bad_request", "error": "pass amount=<zat> or quote=<id>" })));
    };
    match s.backend.check_deposit(amount).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "amount": amount }))),
        Err(r) => (StatusCode::UNPROCESSABLE_ENTITY, Json(deposit_refusal_json(&r))),
    }
}

fn progress_json(q: &crate::store::Quote, required: u32) -> serde_json::Value {
    json!({
        "ok": true,
        "quote": q.quote_id,
        "amount": q.amount_zats,
        "received_zats": q.received_zats,
        "confirmations": q.confirmations,
        "required_confirmations": required,
        "paid": q.paid_emitted,
        "expires_at": q.expires_at,
    })
}

fn deposit_refusal_json(r: &DepositRefusal) -> serde_json::Value {
    let mut v = json!({ "ok": false, "code": r.code(), "error": r.to_string() });
    if let DepositRefusal::ReserveCap { cap, reserve, open_quotes, amount } = r {
        v["cap"] = json!(cap);
        v["reserve"] = json!(reserve);
        v["open_quotes"] = json!(open_quotes);
        v["max_amount_now"] = json!(cap.saturating_sub(reserve.saturating_add(*open_quotes)));
        v["amount"] = json!(amount);
    }
    v
}

/// 200 `{"ok":true,"amount","fee"}`, or 422 `{"ok":false,"code","error",...}`.
async fn withdrawal_quote(State(s): State<AppState>, Query(q): Query<QuoteQuery>) -> impl IntoResponse {
    match s.backend.check_withdrawal(q.amount, q.address.trim()).await {
        Ok(fee) => (StatusCode::OK, Json(json!({ "ok": true, "amount": q.amount, "fee": fee }))),
        Err(r) => (StatusCode::UNPROCESSABLE_ENTITY, Json(refusal_json(&r))),
    }
}

fn refusal_json(r: &QuoteRefusal) -> serde_json::Value {
    let mut v = json!({ "ok": false, "code": r.code(), "error": r.to_string() });
    if let QuoteRefusal::InsufficientReserve { spendable, required, min_confirmations } = r {
        v["spendable"] = json!(spendable);
        v["required"] = json!(required);
        v["min_confirmations"] = json!(min_confirmations);
    }
    v
}

pub async fn serve(addr: SocketAddr, monitor: ReserveMonitor, backend: Arc<ZecBackend>) -> Result<()> {
    let app = Router::new()
        .route("/reserves", get(reserves))
        .route("/withdrawal-quote", get(withdrawal_quote))
        .route("/deposit-quote", get(deposit_quote))
        .with_state(AppState { monitor, backend });
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot listen on {addr} for the status endpoints"))?;
    tracing::info!(%addr, "status endpoints at http://{addr}/reserves, /deposit-quote and /withdrawal-quote");
    axum::serve(listener, app).await.context("status server stopped")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_json_reports_depth() {
        let q = crate::store::Quote {
            quote_id: "q1".into(),
            diversifier_index: 7,
            address: "uregtest1x".into(),
            amount_zats: 50_000,
            received_zats: 50_000,
            confirmations: 3,
            paid_emitted: false,
            expires_at: 1_800_000_000,
        };
        let v = progress_json(&q, 10);
        assert_eq!((v["confirmations"].as_u64(), v["required_confirmations"].as_u64()), (Some(3), Some(10)));
        assert_eq!(v["received_zats"], 50_000);
        assert!(v.get("address").is_none() && v.get("diversifier_index").is_none());
    }

    #[test]
    fn refusal_json_carries_code_and_numbers() {
        let v = refusal_json(&QuoteRefusal::InsufficientReserve { spendable: 275_000, required: 5_020_000, min_confirmations: 1 });
        assert_eq!(v["code"], "insufficient_reserve");
        assert_eq!((v["spendable"].as_u64(), v["required"].as_u64()), (Some(275_000), Some(5_020_000)));
        assert!(v["error"].as_str().unwrap().contains("needs 5020000 zat including the fee"));
        let v = refusal_json(&QuoteRefusal::InvalidAddress("not a valid regtest Zcash address".into()));
        assert_eq!(v["code"], "invalid_address");
        assert!(v.get("spendable").is_none());
    }
}
