//! Plain-HTTP status endpoints (loopback; the web proxy exposes them over HTTPS):
//! - `GET /reserves`: the reserve check (see `reserves`).
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

use crate::{backend::ZecBackend, reserves::ReserveMonitor, withdraw::QuoteRefusal};

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
        .with_state(AppState { monitor, backend });
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot listen on {addr} for the status endpoints"))?;
    tracing::info!(%addr, "status endpoints at http://{addr}/reserves and /withdrawal-quote");
    axum::serve(listener, app).await.context("status server stopped")
}

#[cfg(test)]
mod tests {
    use super::*;

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
