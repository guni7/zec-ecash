//! How the guardian is reached: TLS, and an HMAC on every round request.
//!
//! Files in `<dir>/keys/` (all optional on regtest, all required on MAINNET):
//!   guardian-N.auth       32-byte hex secret shared only with the processor (`make-auth-key`)
//!   guardian-N-tls.crt    this guardian's certificate (PEM, chain first), issued by the CA the
//!   guardian-N-tls.key    processor trusts (ZEC_GUARDIAN_CA), and its private key
//! With an auth secret, `/round1` and `/round2` refuse any request without a valid HMAC, a fresh
//! timestamp and an unseen signature, before the handler runs (so before any nonce exists).
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use tokio::net::{TcpListener, TcpStream};
use zec_frost::wire::{
    Refusal,
    auth::{self, Key, Verifier},
};

use crate::{Args, keys_dir};

pub fn auth_key_path(args: &Args) -> PathBuf {
    keys_dir(args).join(format!("guardian-{}.auth", args.id))
}

fn tls_paths(args: &Args) -> (PathBuf, PathBuf) {
    let k = keys_dir(args);
    (k.join(format!("guardian-{}-tls.crt", args.id)), k.join(format!("guardian-{}-tls.key", args.id)))
}

/// `guardian make-auth-key`: a new secret for this guardian (never over an existing one).
pub fn make_auth_key(args: &Args) -> Result<()> {
    let path = auth_key_path(args);
    zec_wallet::network::write_secret(&path, &Key::random().to_hex())?;
    println!("guardian {}: wrote {} (mode 600)", args.id, path.display());
    println!(
        "  copy it to the processor host as <state>/keys/guardian-{}.auth, and nowhere else: whoever holds it",
        args.id
    );
    println!("  can ask this guardian to sign (the guardian still checks every withdrawal itself).");
    Ok(())
}

/// What `serve` uses, after the MAINNET requirements are checked.
pub struct Security {
    pub auth: Option<Key>,
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

pub fn load(args: &Args, mint: &str) -> Result<Security> {
    let mainnet = zec_wallet::network::current().is_mainnet();
    let auth_path = auth_key_path(args);
    let auth = if auth_path.exists() { Some(Key::read(&auth_path)?) } else { None };
    let (crt, key) = tls_paths(args);
    let tls = if crt.exists() || key.exists() { Some(Arc::new(server_config(&crt, &key)?)) } else { None };
    if mainnet {
        ensure!(
            auth.is_some(),
            "MAINNET guardian needs {} (run `guardian make-auth-key` and give the processor a copy)",
            auth_path.display()
        );
        ensure!(tls.is_some(), "MAINNET guardian needs {} and {} (TLS)", crt.display(), key.display());
        ensure!(
            mint.starts_with("https://"),
            "MAINNET guardian must check quotes at the mint's public https:// URL, not {mint}"
        );
    }
    Ok(Security { auth, tls })
}

fn server_config(crt: &Path, key: &Path) -> Result<rustls::ServerConfig> {
    let certs: Vec<CertificateDer> = CertificateDer::pem_file_iter(crt)
        .with_context(|| format!("cannot read {}", crt.display()))?
        .collect::<Result<_, _>>()
        .with_context(|| format!("bad PEM in {}", crt.display()))?;
    ensure!(!certs.is_empty(), "{} holds no certificate", crt.display());
    let key = PrivateKeyDer::from_pem_file(key).with_context(|| format!("cannot read private key {}", key.display()))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("TLS certificate and key don't match")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// Shared by the middleware.
pub struct AuthState {
    pub key: Option<Key>,
    pub verifier: Mutex<Verifier>,
    pub guardian: u16,
}

/// Body size accepted on round requests (a PCZT is well under this).
const MAX_BODY: usize = 16 * 1024 * 1024;

/// Route layer for `/round1` and `/round2`: without a configured key it passes everything
/// (regtest default); with one, it refuses unless [`Verifier::check`] accepts the request.
pub async fn authenticate(State(state): State<Arc<AuthState>>, req: Request, next: Next) -> Response {
    let Some(key) = &state.key else { return next.run(req).await };
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "request too large");
    };
    let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok());
    let checked = state.verifier.lock().unwrap().check(
        key,
        parts.method.as_str(),
        parts.uri.path(),
        header(auth::TIME_HEADER),
        header(auth::SIG_HEADER),
        &bytes,
        auth::now(),
    );
    if let Err(e) = checked {
        tracing::warn!(guardian = state.guardian, path = parts.uri.path(), "refused unauthenticated request: {e:#}");
        return refuse(StatusCode::UNAUTHORIZED, "unauthenticated");
    }
    next.run(Request::from_parts(parts, Body::from(bytes))).await
}

fn refuse(code: StatusCode, why: &str) -> Response {
    (code, Json(Refusal { refused: why.into() })).into_response()
}

/// A TLS listener for `axum::serve`: TCP accept, then the handshake (bounded, so one slow
/// client can't stall the rest for long). Failed handshakes are logged and skipped.
pub struct TlsListener {
    tcp: TcpListener,
    acceptor: tokio_rustls::TlsAcceptor,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, config: Arc<rustls::ServerConfig>) -> Self {
        TlsListener { tcp, acceptor: tokio_rustls::TlsAcceptor::from(config) }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = match self.tcp.accept().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            match tokio::time::timeout(Duration::from_secs(10), self.acceptor.accept(stream)).await {
                Ok(Ok(tls)) => return (tls, addr),
                Ok(Err(e)) => tracing::warn!(%addr, "TLS handshake failed: {e}"),
                Err(_) => tracing::warn!(%addr, "TLS handshake timed out"),
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::post};
    use tower::ServiceExt;

    fn app(key: Option<Key>) -> (Router, Arc<std::sync::atomic::AtomicUsize>) {
        // Counts how often the handler (where a real guardian makes nonces) runs.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = calls.clone();
        let state = Arc::new(AuthState { key, verifier: Mutex::new(Verifier::default()), guardian: 1 });
        let router = Router::new()
            .route(
                "/round1",
                post(move || {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { "ok" }
                }),
            )
            .route_layer(middleware::from_fn_with_state(state, authenticate));
        (router, calls)
    }

    fn request(key: Option<&Key>, time: u64, body: &'static [u8]) -> Request {
        let mut r = Request::post("/round1");
        if let Some(k) = key {
            r = r
                .header(auth::TIME_HEADER, time.to_string())
                .header(auth::SIG_HEADER, auth::sign(k, "POST", "/round1", time, body));
        }
        r.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn unauthenticated_requests_never_reach_the_handler() {
        let key = Key::random();
        let (app, calls) = app(Some(key.clone()));
        let now = auth::now();
        let ok = app.clone().oneshot(request(Some(&key), now, b"{}")).await.unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        for (what, req) in [
            ("no auth", request(None, now, b"{}")),
            ("wrong key", request(Some(&Key::random()), now, b"{}")),
            ("stale", request(Some(&key), now - 3600, b"{}")),
            ("replay", request(Some(&key), now, b"{}")),
        ] {
            let resp = app.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{what}");
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "only the good request ran the handler");
    }

    #[tokio::test]
    async fn without_a_key_everything_passes_as_before() {
        let (app, calls) = app(None);
        assert_eq!(app.oneshot(request(None, 0, b"{}")).await.unwrap().status(), StatusCode::OK);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
