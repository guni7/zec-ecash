//! Guardian: holds one 2-of-3 FROST share of the mint's spend key and signs withdrawals only
//! after verifying them itself (see policy.rs). Plain HTTP on loopback.
//!
//!   guardian dkg --id N --threshold 2 --participants 3   # distributed DKG on this guardian's
//!                                             # own machine; run again after each file delivery
//!   guardian verify --id N                    # key share + pubkeys + UFVK agree, here and with
//!                                             # the other guardians (see dkg.rs)
//!   guardian check-ufvk --id N                # UFVK's ak == my group key; print first address
//!   guardian make-auth-key --id N             # keys/guardian-N.auth: the secret shared with the
//!                                             # processor that authenticates round requests
//!   guardian serve --id N [--listen ADDR]     # 127.0.0.1:710N (MAINNET: 810N); TLS and request
//!                                             # authentication when configured (see transport.rs;
//!                                             # required on MAINNET)
//!
//! ZEC_NETWORK=mainnet: addresses and the UFVK are mainnet, the default --dir is mainnet, --mint
//! defaults to ZEC_MINT_URL in mainnet/.env and must be the mint's public https:// URL, TLS and
//! request authentication are required, and every log line starts with MAINNET.
//!
//! Files (under --dir, default devnet or mainnet):
//!   keys/guardian-N.key      this guardian's KeyPackage (secret; survives resets)
//!   keys/frost-pubkeys.json  the group's public key package
//!   keys/mint.ufvk           the reserve's UFVK (written by `zec-processor make-ufvk`)
//!   dkg/{state,inbox,outbox} the ceremony's working files (see dkg.rs)
//!   guardian-N.signed.json   quote id -> sighash signed (mint-DB state; reset with it)
//! Nothing here generates keys implicitly: missing key files are a startup error.
mod dkg;
mod nonces;
mod policy;
mod transport;

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use zcash_keys::keys::UnifiedAddressRequest;
use zec_frost::{
    MAX_SIGNERS,
    redpallas::{
        self as frost, Identifier, SigningPackage,
        keys::{KeyPackage, PublicKeyPackage},
    },
    wire::{Refusal, Round1Request, Round1Response, Round2Request, Round2Response, Status},
};
use zec_wallet::Pczt;

use crate::{nonces::Nonces, policy::MintQuote};

const MAX_ACTIONS: usize = 64;

struct Args {
    cmd: Vec<String>,
    id: u16,
    threshold: Option<u16>,
    participants: Option<u16>,
    dir: PathBuf,
    mint: String,
    /// `serve`: address to listen on (default 127.0.0.1:710N, MAINNET 810N).
    listen: Option<String>,
}

fn parse_args() -> Result<Args> {
    let network = zec_wallet::network::init()?;
    let mut args = Args {
        cmd: vec![],
        id: 0,
        threshold: None,
        participants: None,
        dir: network.state_dir().into(),
        mint: format!("http://127.0.0.1:{}", network.port(8085)),
        listen: None,
    };
    let mut mint_given = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--id" => args.id = it.next().context("--id N")?.parse().context("--id must be 1..=3")?,
            "--dir" => args.dir = it.next().context("--dir PATH")?.into(),
            "--threshold" => args.threshold = Some(it.next().context("--threshold T")?.parse().context("--threshold")?),
            "--participants" => {
                args.participants = Some(it.next().context("--participants N")?.parse().context("--participants")?)
            }
            "--mint" => {
                args.mint = it.next().context("--mint URL")?;
                mint_given = true;
            }
            // Empty means the default (systemd passes `--listen ""` if ZEC_GUARDIAN_LISTEN is unset).
            "--listen" => args.listen = Some(it.next().context("--listen HOST:PORT")?).filter(|l| !l.is_empty()),
            _ => args.cmd.push(a),
        }
    }
    ensure!((1..=MAX_SIGNERS).contains(&args.id), "--id must be 1..={MAX_SIGNERS}");
    if network.is_mainnet() && !mint_given {
        // The mint's public URL, from this machine's mainnet/.env (never the devnet's .env).
        args.mint = dotenv_value(&network.state_dir().join(".env"), "ZEC_MINT_URL").unwrap_or_default();
    }
    Ok(args)
}

/// `KEY=value` from an env file (MAINNET guardians read mainnet/.env, never the devnet's .env).
fn dotenv_value(path: &Path, key: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()?.lines().find_map(|l| {
        l.trim().strip_prefix(key)?.strip_prefix('=').map(|v| v.trim().trim_matches('"').to_owned())
    })
}

fn ident(id: u16) -> Result<Identifier> {
    Identifier::try_from(id).map_err(|e| anyhow!("bad identifier {id}: {e}"))
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("cannot read {}", path.display()))?)
        .with_context(|| format!("cannot parse {}", path.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let network = zec_wallet::network::current();
    if network.is_mainnet() {
        eprintln!("guardian {}: *** MAINNET (real ZEC) *** keys in {}", args.id, keys_dir(&args).display());
    }
    // Size-capped: <dir>/logs/guardian-N.log (+ rotated files), see the devlog crate.
    devlog::init_labeled(
        &args.dir.join("logs"),
        &format!("guardian-{}", args.id),
        "info",
        network.is_mainnet().then_some("MAINNET "),
    )?;
    match args.cmd.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["dkg"] => dkg::dkg(&args),
        ["verify"] => dkg::verify(&args),
        ["make-auth-key"] => transport::make_auth_key(&args),
        ["check-ufvk"] => check_ufvk(&args).map(|_| ()),
        ["serve"] => serve(args).await,
        _ => bail!("usage: guardian --id N [--dir devnet|mainnet] [--mint URL] <dkg --threshold 2 --participants 3|verify|make-auth-key|check-ufvk|serve>"),
    }
}

// ---- DKG (reddsa::frost::redpallas::keys::dkg; group key made even-y by reddsa's post_dkg) ----

fn keys_dir(args: &Args) -> PathBuf {
    args.dir.join("keys")
}

fn key_path(args: &Args) -> PathBuf {
    keys_dir(args).join(format!("guardian-{}.key", args.id))
}

/// Reads a key file that must already exist; never creates one.
fn read_key_file<T: serde::de::DeserializeOwned>(path: &Path, what: &str) -> Result<T> {
    ensure!(
        path.exists(),
        "{what} {} is missing. Keys are never generated implicitly: restore it, or create new \
         keys with scripts/devnet-reset.sh --new-keys (MAINNET: the DKG ceremony in docs/deploy-mainnet.md)",
        path.display()
    );
    read_json(path)
}

// ---- keys ----

struct Keys {
    key: KeyPackage,
    pubkeys: PublicKeyPackage,
    fvk: orchard::keys::FullViewingKey,
    first_address: String,
}

/// Loads this guardian's keys and checks they are consistent with each other and with the UFVK
/// the processor imported (its `ak` must be our group key).
fn check_ufvk(args: &Args) -> Result<Keys> {
    let key: KeyPackage = read_key_file(&key_path(args), "key share")?;
    let pubkeys: PublicKeyPackage = read_key_file(&keys_dir(args).join("frost-pubkeys.json"), "group public keys")?;
    let ufvk_path = keys_dir(args).join("mint.ufvk");
    ensure!(ufvk_path.exists(), "{} is missing: the processor host makes it from frost-pubkeys.json (`zec-processor make-ufvk`); copy it here (devnet: scripts/devnet-reset.sh --new-keys)", ufvk_path.display());
    let ufvk = zec_wallet::frost::read_ufvk(&ufvk_path)?;
    ensure!(key.verifying_key() == pubkeys.verifying_key(), "key share and frost-pubkeys.json disagree");
    ensure!(*key.identifier() == ident(args.id)?, "guardian-{}.key belongs to another guardian", args.id);
    let group = zec_frost::group_key_bytes(&pubkeys)?;
    ensure!(
        zec_wallet::frost::ufvk_ak(&ufvk)? == group,
        "mint.ufvk's ak is not this group's key: refusing to serve it"
    );
    let (ua, _) = ufvk
        .default_address(UnifiedAddressRequest::ORCHARD)
        .map_err(|e| anyhow!("address: {e:?}"))?;
    let network = zec_wallet::network::current();
    let first_address = ua.encode(&network.params());
    println!("guardian {} ({}): UFVK ak matches group key {}", args.id, network.label(), hex::encode(group));
    println!("guardian {} ({}): mint address {first_address}", args.id, network.label());
    let fvk = ufvk.orchard().context("UFVK has no Orchard key")?.clone();
    Ok(Keys { key, pubkeys, fvk, first_address })
}

// ---- daemon ----

struct Guardian {
    id: u16,
    keys: Keys,
    mint: String,
    /// Fetches quotes from the mint: web roots, plus ZEC_MINT_CA if set (a private CA in front of
    /// the mint, e.g. staging).
    mint_client: zec_frost::wire::Client,
    nonces: Mutex<Nonces>,
    signed_path: PathBuf,
    /// quote id -> hex sighash this guardian signed for it.
    signed: Mutex<HashMap<String, String>>,
}

type Shared = Arc<Guardian>;

async fn serve(args: Args) -> Result<()> {
    // Transport requirements first: on MAINNET a guardian without TLS or request auth never starts.
    let mint = args.mint.trim_end_matches('/').to_owned();
    let security = transport::load(&args, &mint)?;
    let keys = check_ufvk(&args)?;
    let signed_path = args.dir.join(format!("guardian-{}.signed.json", args.id));
    let signed = if signed_path.exists() { read_json(&signed_path)? } else { HashMap::new() };
    let addr = args
        .listen
        .clone()
        .unwrap_or_else(|| format!("127.0.0.1:{}", zec_wallet::network::current().port(7100 + args.id)));
    let network = zec_wallet::network::current();
    let mint_ca = std::env::var("ZEC_MINT_CA").ok().filter(|v| !v.is_empty()).or_else(|| {
        network.is_mainnet().then(|| dotenv_value(&network.state_dir().join(".env"), "ZEC_MINT_CA")).flatten()
    });
    let mint_ca = mint_ca.filter(|v| !v.is_empty()); // `ZEC_MINT_CA=` means none
    let mint_client = zec_frost::wire::Client::with_ca(mint_ca.as_deref().map(Path::new))?;
    let g = Arc::new(Guardian {
        id: args.id,
        keys,
        mint,
        mint_client,
        nonces: Mutex::new(Nonces::default()),
        signed_path,
        signed: Mutex::new(signed),
    });
    // Expire unused nonces even when no requests arrive.
    let sweeper = g.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            sweeper.nonces.lock().unwrap().expire();
        }
    });

    let auth = Arc::new(transport::AuthState {
        key: security.auth,
        verifier: Mutex::new(zec_frost::wire::auth::Verifier::default()),
        guardian: g.id,
    });
    let authenticated = auth.key.is_some();
    // Round requests pass the authentication layer first: an unauthenticated request is refused
    // before round1 can generate a nonce. /status (public information) stays open.
    let app = Router::new()
        .route("/round1", post(round1))
        .route("/round2", post(round2))
        .route_layer(axum::middleware::from_fn_with_state(auth, transport::authenticate))
        .route("/status", get(status))
        .with_state(g.clone());
    let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("cannot bind {addr}"))?;
    tracing::info!(
        guardian = g.id, %addr, tls = security.tls.is_some(), authenticated, mint = %g.mint,
        address = %g.keys.first_address, "guardian serving"
    );
    match security.tls {
        Some(tls) => axum::serve(transport::TlsListener::new(listener, tls), app).await?,
        None => axum::serve(listener, app).await?,
    }
    Ok(())
}

fn refuse(status: StatusCode, reason: impl Into<String>) -> Response {
    let reason = reason.into();
    tracing::warn!("refused: {reason}");
    (status, Json(Refusal { refused: reason })).into_response()
}

async fn status(State(g): State<Shared>) -> Json<Status> {
    Json(Status {
        guardian: g.id,
        group_key: hex::encode(zec_frost::group_key_bytes(&g.keys.pubkeys).unwrap_or_default()),
        open_sessions: g.nonces.lock().unwrap().len(),
        signed_quotes: g.signed.lock().unwrap().len(),
    })
}

async fn round1(State(g): State<Shared>, Json(req): Json<Round1Request>) -> Response {
    if req.action_count == 0 || req.action_count > MAX_ACTIONS {
        return refuse(StatusCode::BAD_REQUEST, format!("action_count must be 1..={MAX_ACTIONS}"));
    }
    let mut rng = rand::thread_rng();
    let (nonces, commitments): (Vec<_>, Vec<_>) =
        (0..req.action_count).map(|_| frost::round1::commit(g.keys.key.signing_share(), &mut rng)).unzip();
    let commitments: Result<Vec<String>, _> = commitments.iter().map(|c| c.serialize().map(hex::encode)).collect();
    let Ok(commitments) = commitments else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "cannot serialize commitments");
    };
    if let Err(e) = g.nonces.lock().unwrap().insert(&req.session, &req.quote_id, nonces) {
        return refuse(StatusCode::CONFLICT, e);
    }
    tracing::info!(session = %req.session, quote_id = %req.quote_id, actions = req.action_count, "round 1");
    Json(Round1Response { guardian: g.id, commitments }).into_response()
}

async fn round2(State(g): State<Shared>, Json(req): Json<Round2Request>) -> Response {
    // The session's nonces are removed now, whatever happens next: never reused.
    let nonces = match g.nonces.lock().unwrap().take(&req.session, &req.quote_id) {
        Ok(n) => n,
        Err(e) => return refuse(StatusCode::CONFLICT, e),
    };
    match sign_round2(&g, &req, nonces).await {
        Ok(shares) => {
            tracing::info!(session = %req.session, quote_id = %req.quote_id, shares = shares.len(), "round 2: signed");
            Json(Round2Response { guardian: g.id, shares }).into_response()
        }
        Err(e) => refuse(StatusCode::FORBIDDEN, format!("{e:#}")),
    }
}

async fn sign_round2(g: &Guardian, req: &Round2Request, nonces: Vec<frost::round1::SigningNonces>) -> Result<Vec<String>> {
    let pczt = Pczt::parse(&hex::decode(&req.pczt)?).map_err(|e| anyhow!("not a PCZT: {e:?}"))?;
    let tx = policy::summarize(&pczt, &g.keys.fvk)?;

    // a. Ask the mint, not the coordinator, what this quote is.
    let url = format!("{}/v1/melt/quote/zec/{}", g.mint, req.quote_id);
    let quote: MintQuote = g.mint_client.get_json(&url, Duration::from_secs(20)).await.context("(a) mint quote")?;
    let receiver = zec_wallet::frost::orchard_receiver(&quote.request).context("(b) quote address")?;

    let packages: Vec<SigningPackage> = req
        .signing_packages
        .iter()
        .map(|p| SigningPackage::deserialize(&hex::decode(p)?).map_err(|e| anyhow!("bad signing package: {e}")))
        .collect::<Result<_>>()?;
    let messages: Vec<Vec<u8>> = packages.iter().map(|p| p.message().to_vec()).collect();
    let prior = g.signed.lock().unwrap().get(&req.quote_id).map(|h| {
        let mut out = [0u8; 32];
        hex::decode_to_slice(h, &mut out).ok();
        out
    });
    policy::check(&quote, &receiver, &tx, &messages, prior).map_err(|e| anyhow!(e))?;
    ensure!(nonces.len() == packages.len(), "{} nonces for {} signing packages", nonces.len(), packages.len());

    // h. Remember what we signed for this quote before handing out shares.
    {
        let mut signed = g.signed.lock().unwrap();
        signed.insert(req.quote_id.clone(), hex::encode(tx.sighash));
        write_json(&g.signed_path, &*signed)?;
    }

    let spends = zec_wallet::frost::spends_to_sign(&pczt)?;
    spends
        .iter()
        .zip(&packages)
        .zip(&nonces)
        .map(|((spend, package), nonce)| {
            let share = zec_frost::sign_share(package, nonce, &g.keys.key, &spend.alpha)?;
            Ok(hex::encode(share.serialize()))
        })
        .collect()
}
