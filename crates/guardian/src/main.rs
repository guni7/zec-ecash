//! Guardian: holds one 2-of-3 FROST share of the mint's spend key and signs withdrawals only
//! after verifying them itself (see policy.rs). Plain HTTP on loopback.
//!
//!   guardian dkg part1|part2|part3 --id N     # one DKG step (scripts/dkg runs all of them)
//!   guardian check-ufvk --id N                # UFVK's ak == my group key; print first address
//!   guardian serve --id N                     # HTTP on 127.0.0.1:710N (MAINNET: 810N)
//!
//! ZEC_NETWORK=mainnet: addresses and the UFVK are mainnet, the default --dir is mainnet, the
//! default --mint is http://127.0.0.1:9085, and every log line starts with MAINNET.
//!
//! Files (under --dir, default devnet or mainnet):
//!   keys/guardian-N.key      this guardian's KeyPackage (secret; survives resets)
//!   keys/frost-pubkeys.json  the group's public key package
//!   keys/mint.ufvk           the reserve's UFVK (written by `zec-processor make-ufvk`)
//!   keys/dkg/                DKG exchange; secret packages are deleted after part 3
//!   guardian-N.signed.json   quote id -> sighash signed (mint-DB state; reset with it)
//! Nothing here generates keys implicitly: missing key files are a startup error.
mod nonces;
mod policy;

use std::{
    collections::{BTreeMap, HashMap},
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
    MAX_SIGNERS, MIN_SIGNERS,
    redpallas::{
        self as frost, Identifier, SigningPackage,
        keys::{KeyPackage, PublicKeyPackage, dkg},
    },
    wire::{Refusal, Round1Request, Round1Response, Round2Request, Round2Response, Status},
};
use zec_wallet::Pczt;

use crate::{nonces::Nonces, policy::MintQuote};

const MAX_ACTIONS: usize = 64;

struct Args {
    cmd: Vec<String>,
    id: u16,
    dir: PathBuf,
    mint: String,
}

fn parse_args() -> Result<Args> {
    let network = zec_wallet::network::init()?;
    let mut args = Args {
        cmd: vec![],
        id: 0,
        dir: network.state_dir().into(),
        mint: format!("http://127.0.0.1:{}", network.port(8085)),
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--id" => args.id = it.next().context("--id N")?.parse().context("--id must be 1..=3")?,
            "--dir" => args.dir = it.next().context("--dir PATH")?.into(),
            "--mint" => args.mint = it.next().context("--mint URL")?,
            _ => args.cmd.push(a),
        }
    }
    ensure!((1..=MAX_SIGNERS).contains(&args.id), "--id must be 1..={MAX_SIGNERS}");
    Ok(args)
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
        ["dkg", "part1"] => dkg_part1(&args),
        ["dkg", "part2"] => dkg_part2(&args),
        ["dkg", "part3"] => dkg_part3(&args),
        ["check-ufvk"] => check_ufvk(&args).map(|_| ()),
        ["serve"] => serve(args).await,
        _ => bail!("usage: guardian --id N [--dir devnet|mainnet] [--mint URL] <dkg part1|part2|part3|check-ufvk|serve>"),
    }
}

// ---- DKG (reddsa::frost::redpallas::keys::dkg; group key made even-y by reddsa's post_dkg) ----

fn keys_dir(args: &Args) -> PathBuf {
    args.dir.join("keys")
}

fn dkg_dir(args: &Args) -> PathBuf {
    keys_dir(args).join("dkg")
}

fn key_path(args: &Args) -> PathBuf {
    keys_dir(args).join(format!("guardian-{}.key", args.id))
}

/// Reads a key file that must already exist; never creates one.
fn read_key_file<T: serde::de::DeserializeOwned>(path: &Path, what: &str) -> Result<T> {
    ensure!(
        path.exists(),
        "{what} {} is missing. Keys are never generated implicitly: restore it, or create new \
         keys with scripts/devnet-reset.sh --new-keys (MAINNET: scripts/mainnet-dkg.sh)",
        path.display()
    );
    read_json(path)
}

fn dkg_part1(args: &Args) -> Result<()> {
    let (secret, package) = dkg::part1(ident(args.id)?, MAX_SIGNERS, MIN_SIGNERS, rand::thread_rng())?;
    write_json(&dkg_dir(args).join(format!("r1-secret-{}.json", args.id)), &secret)?;
    write_json(&dkg_dir(args).join(format!("r1-{}.json", args.id)), &package)?;
    println!("guardian {}: DKG round 1 package published", args.id);
    Ok(())
}

/// Everyone else's round-1 packages.
fn others_r1(args: &Args) -> Result<BTreeMap<Identifier, dkg::round1::Package>> {
    (1..=MAX_SIGNERS)
        .filter(|&j| j != args.id)
        .map(|j| Ok((ident(j)?, read_json(&dkg_dir(args).join(format!("r1-{j}.json")))?)))
        .collect()
}

fn dkg_part2(args: &Args) -> Result<()> {
    let secret_path = dkg_dir(args).join(format!("r1-secret-{}.json", args.id));
    let (secret, packages) = dkg::part2(read_json(&secret_path)?, &others_r1(args)?)?;
    write_json(&dkg_dir(args).join(format!("r2-secret-{}.json", args.id)), &secret)?;
    fs::remove_file(&secret_path)?;
    for (to, package) in packages {
        let to: u16 = (1..=MAX_SIGNERS).find(|&j| ident(j).ok() == Some(to)).context("unknown recipient")?;
        // Devnet: a shared directory stands in for the private channel to each peer.
        write_json(&dkg_dir(args).join(format!("r2-{}-to-{to}.json", args.id)), &package)?;
    }
    println!("guardian {}: DKG round 2 packages sent", args.id);
    Ok(())
}

fn dkg_part3(args: &Args) -> Result<()> {
    let secret_path = dkg_dir(args).join(format!("r2-secret-{}.json", args.id));
    let r2: BTreeMap<Identifier, dkg::round2::Package> = (1..=MAX_SIGNERS)
        .filter(|&j| j != args.id)
        .map(|j| Ok((ident(j)?, read_json(&dkg_dir(args).join(format!("r2-{j}-to-{}.json", args.id)))?)))
        .collect::<Result<_>>()?;
    let (key_package, pubkeys) = dkg::part3(&read_json(&secret_path)?, &others_r1(args)?, &r2)?;
    write_json(&key_path(args), &key_package)?;
    write_json(&dkg_dir(args).join(format!("pubkeys-{}.json", args.id)), &pubkeys)?;
    fs::remove_file(&secret_path)?;
    for j in (1..=MAX_SIGNERS).filter(|&j| j != args.id) {
        let _ = fs::remove_file(dkg_dir(args).join(format!("r2-{j}-to-{}.json", args.id)));
    }
    println!(
        "guardian {}: key share saved to {}; group key {}",
        args.id,
        key_path(args).display(),
        hex::encode(zec_frost::group_key_bytes(&pubkeys)?)
    );
    Ok(())
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
    ensure!(ufvk_path.exists(), "{} is missing (run scripts/devnet-reset.sh --new-keys; MAINNET: scripts/mainnet-dkg.sh)", ufvk_path.display());
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
    nonces: Mutex<Nonces>,
    signed_path: PathBuf,
    /// quote id -> hex sighash this guardian signed for it.
    signed: Mutex<HashMap<String, String>>,
}

type Shared = Arc<Guardian>;

async fn serve(args: Args) -> Result<()> {
    let keys = check_ufvk(&args)?;
    let signed_path = args.dir.join(format!("guardian-{}.signed.json", args.id));
    let signed = if signed_path.exists() { read_json(&signed_path)? } else { HashMap::new() };
    let addr = format!("127.0.0.1:{}", zec_wallet::network::current().port(7100 + args.id));
    let g = Arc::new(Guardian {
        id: args.id,
        keys,
        mint: args.mint.trim_end_matches('/').to_owned(),
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

    let app = Router::new()
        .route("/round1", post(round1))
        .route("/round2", post(round2))
        .route("/status", get(status))
        .with_state(g.clone());
    let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("cannot bind {addr}"))?;
    tracing::info!(guardian = g.id, %addr, mint = %g.mint, address = %g.keys.first_address, "guardian serving");
    axum::serve(listener, app).await?;
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
    let quote: MintQuote = zec_frost::wire::get_json(&url, Duration::from_secs(20)).await.context("(a) mint quote")?;
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
