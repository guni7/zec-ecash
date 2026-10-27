//! The coordinator <-> guardian protocol and a minimal JSON client.
//!
//! Transport: plain HTTP on the devnet; on mainnet TLS (the guardian's certificate, issued by the
//! operator's private CA, which the processor trusts) and every round request authenticated with
//! [`auth`] (HMAC-SHA256 with a per-guardian secret, a timestamp and a replay window).
//! Binary values travel hex-encoded: FROST commitments, signing packages and signature shares use
//! their frost `serialize()` encodings, the PCZT its own.
use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow, bail, ensure};
use http_body_util::{BodyExt, Full};
use hyper::{Uri, body::Bytes};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{CertificateDer, ServerName, pem::PemObject};
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

/// A JSON-over-HTTP(S) client: TLS trusts the web roots plus an optional extra CA (the
/// guardians' private CA), and requests can be signed with a guardian's HMAC secret.
#[derive(Clone)]
pub struct Client {
    tls: Arc<rustls::ClientConfig>,
    hmac_key: Option<auth::Key>,
}

impl Client {
    /// Web roots only (public HTTPS, e.g. the mint's public URL), no request signing.
    pub fn public() -> Self {
        Self::with_ca(None).expect("web roots alone always build")
    }

    /// Web roots plus the CA certificate(s) in `ca_pem`, if given.
    pub fn with_ca(ca_pem: Option<&Path>) -> Result<Self> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = ca_pem {
            let certs: Vec<CertificateDer> = CertificateDer::pem_file_iter(path)
                .with_context(|| format!("cannot read CA {}", path.display()))?
                .collect::<Result<_, _>>()
                .with_context(|| format!("bad PEM in {}", path.display()))?;
            ensure!(!certs.is_empty(), "{} holds no certificate", path.display());
            for cert in certs {
                roots.add(cert).with_context(|| format!("bad CA certificate in {}", path.display()))?;
            }
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Client { tls: Arc::new(config), hmac_key: None })
    }

    /// Signs every request with `key` (see [`auth`]).
    pub fn signing(mut self, key: auth::Key) -> Self {
        self.hmac_key = Some(key);
        self
    }

    pub async fn get_json<T: DeserializeOwned>(&self, url: &str, timeout: Duration) -> Result<T> {
        self.send("GET", url, Vec::new(), timeout).await
    }

    pub async fn post_json<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        url: &str,
        body: &Req,
        timeout: Duration,
    ) -> Result<Resp> {
        self.send("POST", url, serde_json::to_vec(body)?, timeout).await
    }

    async fn send<T: DeserializeOwned>(&self, method: &str, url: &str, body: Vec<u8>, timeout: Duration) -> Result<T> {
        let (status, body) = tokio::time::timeout(timeout, self.exchange(method, url, body))
            .await
            .map_err(|_| anyhow!("{url}: no answer within {timeout:?}"))??;
        if !status.is_success() {
            let reason = serde_json::from_slice::<Refusal>(&body)
                .map(|r| r.refused)
                .unwrap_or_else(|_| String::from_utf8_lossy(&body).into_owned());
            bail!("{url}: {status}: {reason}");
        }
        serde_json::from_slice(&body).with_context(|| format!("{url}: unexpected response"))
    }

    async fn exchange(&self, method: &str, url: &str, body: Vec<u8>) -> Result<(hyper::StatusCode, Bytes)> {
        let uri: Uri = url.parse().with_context(|| format!("bad URL {url}"))?;
        let https = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => bail!("{url}: only http:// and https:// URLs"),
        };
        let host = uri.host().with_context(|| format!("{url}: no host"))?.trim_matches(|c| c == '[' || c == ']').to_owned();
        let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
        let path = uri.path_and_query().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "/".into());

        let mut req = hyper::Request::builder()
            .method(method)
            .uri(&path)
            .header("host", uri.authority().map(|a| a.as_str()).unwrap_or(&host))
            .header("content-type", "application/json");
        if let Some(key) = &self.hmac_key {
            let time = auth::now();
            req = req
                .header(auth::TIME_HEADER, time.to_string())
                .header(auth::SIG_HEADER, auth::sign(key, method, uri.path(), time, &body));
        }
        let req = req.body(Full::new(Bytes::from(body)))?;

        let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .with_context(|| format!("{url} unreachable"))?;
        if https {
            let name = ServerName::try_from(host.clone()).with_context(|| format!("{url}: bad server name"))?;
            let tls = tokio_rustls::TlsConnector::from(self.tls.clone())
                .connect(name, tcp)
                .await
                .with_context(|| format!("{url}: TLS handshake failed (certificate not trusted?)"))?;
            request_over(TokioIo::new(tls), req, url).await
        } else {
            request_over(TokioIo::new(tcp), req, url).await
        }
    }
}

/// One HTTP/1 request on its own connection.
async fn request_over<IO>(io: IO, req: hyper::Request<Full<Bytes>>, url: &str) -> Result<(hyper::StatusCode, Bytes)>
where
    IO: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.with_context(|| format!("{url}: HTTP handshake"))?;
    tokio::spawn(conn);
    let resp = sender.send_request(req).await.with_context(|| format!("{url} unreachable"))?;
    let status = resp.status();
    let body = resp.into_body().collect().await.context("reading response")?.to_bytes();
    Ok((status, body))
}

/// [`Client::public`] `get_json`, for unsigned requests.
pub async fn get_json<T: DeserializeOwned>(url: &str, timeout: Duration) -> Result<T> {
    Client::public().get_json(url, timeout).await
}

/// [`Client::public`] `post_json`, for unsigned requests.
pub async fn post_json<Req: Serialize, Resp: DeserializeOwned>(url: &str, body: &Req, timeout: Duration) -> Result<Resp> {
    Client::public().post_json(url, body, timeout).await
}

/// Request authentication between the processor and one guardian.
///
/// Each guardian has its own 32-byte secret, shared only with the processor. A request carries
/// `x-zec-time` (unix seconds) and `x-zec-auth`: hex HMAC-SHA256 over
/// `"zec-guardian-v1\n" METHOD "\n" PATH "\n" TIME "\n" BODY`. The guardian accepts it only if the
/// MAC matches, TIME is within [`WINDOW_SECS`] of its clock, and the same MAC was not seen
/// within the window (no replays).
pub mod auth {
    use std::{collections::HashMap, path::Path};

    use anyhow::{Context, Result, bail, ensure};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    pub const TIME_HEADER: &str = "x-zec-time";
    pub const SIG_HEADER: &str = "x-zec-auth";
    /// Accepted clock difference, seconds (either way).
    pub const WINDOW_SECS: u64 = 60;

    #[derive(Clone)]
    pub struct Key([u8; 32]);

    impl Key {
        pub fn from_bytes(bytes: [u8; 32]) -> Self {
            Key(bytes)
        }

        /// A fresh random secret.
        pub fn random() -> Self {
            let mut b = [0u8; 32];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
            Key(b)
        }

        pub fn to_hex(&self) -> String {
            hex_encode(&self.0)
        }

        /// Reads a hex secret file (as written by `guardian make-auth-key`).
        pub fn read(path: &Path) -> Result<Self> {
            let s = std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
            let bytes = hex_decode(s.trim()).with_context(|| format!("{} is not hex", path.display()))?;
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| anyhow::anyhow!("{} must hold 32 bytes", path.display()))?;
            Ok(Key(bytes))
        }

        fn mac(&self, method: &str, path: &str, time: u64, body: &[u8]) -> Hmac<Sha256> {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("any key length");
            mac.update(format!("zec-guardian-v1\n{method}\n{path}\n{time}\n").as_bytes());
            mac.update(body);
            mac
        }
    }

    pub fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    pub fn sign(key: &Key, method: &str, path: &str, time: u64, body: &[u8]) -> String {
        hex_encode(&key.mac(method, path, time, body).finalize().into_bytes())
    }

    /// Checks one request, and remembers its MAC so it can't be replayed. Errors name the reason
    /// (for the guardian's log; the client gets a bare 401).
    #[derive(Default)]
    pub struct Verifier {
        /// MAC -> its timestamp, for replay detection within the window.
        seen: HashMap<String, u64>,
    }

    impl Verifier {
        #[allow(clippy::too_many_arguments)]
        pub fn check(
            &mut self,
            key: &Key,
            method: &str,
            path: &str,
            time: Option<&str>,
            sig: Option<&str>,
            body: &[u8],
            now: u64,
        ) -> Result<()> {
            let (Some(time), Some(sig)) = (time, sig) else { bail!("unauthenticated: no {TIME_HEADER} / {SIG_HEADER}") };
            let time: u64 = time.trim().parse().context("bad timestamp")?;
            ensure!(time.abs_diff(now) <= WINDOW_SECS, "timestamp {time} outside the {WINDOW_SECS}s window (now {now})");
            let sig_bytes = hex_decode(sig.trim()).context("bad signature encoding")?;
            key.mac(method, path, time, body).verify_slice(&sig_bytes).map_err(|_| anyhow::anyhow!("bad signature"))?;
            self.seen.retain(|_, t| t.abs_diff(now) <= 2 * WINDOW_SECS);
            let sig = sig.trim().to_ascii_lowercase();
            ensure!(!self.seen.contains_key(&sig), "replayed request");
            self.seen.insert(sig, time);
            Ok(())
        }
    }

    fn hex_encode(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn hex_decode(s: &str) -> Result<Vec<u8>> {
        ensure!(s.len().is_multiple_of(2), "odd length");
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).context("not hex")).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn accepts_once_within_the_window() {
            let key = Key::random();
            let mut v = Verifier::default();
            let (now, body) = (1_000_000, br#"{"a":1}"#);
            let sig = sign(&key, "POST", "/round1", now, body);
            let t = now.to_string();
            assert!(v.check(&key, "POST", "/round1", Some(&t), Some(&sig), body, now + 5).is_ok());
            let e = v.check(&key, "POST", "/round1", Some(&t), Some(&sig), body, now + 6).unwrap_err();
            assert!(e.to_string().contains("replayed"), "{e}");
        }

        #[test]
        fn refuses_anything_off() {
            let (key, other) = (Key::random(), Key::random());
            let mut v = Verifier::default();
            let (now, body) = (1_000_000, b"{}");
            let sig = sign(&key, "POST", "/round1", now, body);
            let t = now.to_string();
            let mut check = |k: &Key, m: &str, p: &str, t: Option<&str>, s: Option<&str>, b: &[u8], at: u64| {
                v.check(k, m, p, t, s, b, at).unwrap_err().to_string()
            };
            assert!(check(&key, "POST", "/round1", None, None, body, now).contains("unauthenticated"));
            assert!(check(&other, "POST", "/round1", Some(&t), Some(&sig), body, now).contains("bad signature"), "other guardian's key");
            assert!(check(&key, "POST", "/round2", Some(&t), Some(&sig), body, now).contains("bad signature"), "other path");
            assert!(check(&key, "POST", "/round1", Some(&t), Some(&sig), b"{ }", now).contains("bad signature"), "other body");
            assert!(check(&key, "POST", "/round1", Some(&t), Some(&sig), body, now + 61).contains("window"), "stale");
            assert!(check(&key, "POST", "/round1", Some(&t), Some(&sig), body, now - 61).contains("window"), "future");
        }

        #[test]
        fn key_file_roundtrip() {
            let key = Key::random();
            let path = std::env::temp_dir().join(format!("zec-auth-key-{}", std::process::id()));
            std::fs::write(&path, key.to_hex()).unwrap();
            assert_eq!(Key::read(&path).unwrap().to_hex(), key.to_hex());
            std::fs::write(&path, "abcd").unwrap();
            assert!(Key::read(&path).is_err());
            std::fs::remove_file(&path).unwrap();
        }
    }
}
