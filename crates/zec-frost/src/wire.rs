//! The coordinator <-> guardian protocol (JSON over plain HTTP on the devnet) and a minimal
//! JSON client. Binary values travel hex-encoded: FROST commitments, signing packages and
//! signature shares use their frost `serialize()` encodings, the PCZT its own.
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::{client::legacy::Client, rt::TokioExecutor};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// `POST /round1`: one fresh nonce commitment per spend to be signed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Request {
    pub session: String,
    pub quote_id: String,
    pub action_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round1Response {
    pub guardian: u16,
    /// Hex `SigningCommitments`, one per spend, in `spends_to_sign` order.
    pub commitments: Vec<String>,
}

/// `POST /round2`: the full PCZT (the guardian re-derives everything from it) and one
/// signing package per spend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Request {
    pub session: String,
    pub quote_id: String,
    /// Hex-serialized PCZT.
    pub pczt: String,
    /// Hex `SigningPackage`, one per spend, in `spends_to_sign` order.
    pub signing_packages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round2Response {
    pub guardian: u16,
    /// Hex `SignatureShare`, one per spend.
    pub shares: Vec<String>,
}

/// Body of a 4xx/5xx answer: why the guardian won't sign.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Refusal {
    pub refused: String,
}

/// `GET /status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Status {
    pub guardian: u16,
    /// Hex group key (the mint UFVK's Orchard `ak`).
    pub group_key: String,
    pub open_sessions: usize,
    pub signed_quotes: usize,
}

pub async fn get_json<T: DeserializeOwned>(url: &str, timeout: Duration) -> Result<T> {
    send::<T>(hyper::Request::get(url).body(Full::new(Bytes::new()))?, url, timeout).await
}

pub async fn post_json<Req: Serialize, Resp: DeserializeOwned>(
    url: &str,
    body: &Req,
    timeout: Duration,
) -> Result<Resp> {
    let body = serde_json::to_vec(body)?;
    let req = hyper::Request::post(url)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body)))?;
    send::<Resp>(req, url, timeout).await
}

async fn send<T: DeserializeOwned>(req: hyper::Request<Full<Bytes>>, url: &str, timeout: Duration) -> Result<T> {
    let client = Client::builder(TokioExecutor::new()).build_http::<Full<Bytes>>();
    let resp = tokio::time::timeout(timeout, async {
        let resp = client.request(req).await.with_context(|| format!("{url} unreachable"))?;
        let status = resp.status();
        let body = resp.into_body().collect().await.context("reading response")?.to_bytes();
        anyhow::Ok((status, body))
    })
    .await
    .map_err(|_| anyhow!("{url}: no answer within {timeout:?}"))??;
    let (status, body) = resp;
    if !status.is_success() {
        let reason = serde_json::from_slice::<Refusal>(&body)
            .map(|r| r.refused)
            .unwrap_or_else(|_| String::from_utf8_lossy(&body).into_owned());
        bail!("{url}: {status}: {reason}");
    }
    serde_json::from_slice(&body).with_context(|| format!("{url}: unexpected response"))
}
