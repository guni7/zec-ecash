//! Distributed 2-of-3 DKG: each guardian runs this on its own machine, and the operator carries
//! files between machines.
//!
//!   guardian dkg --id N --threshold 2 --participants 3     (run again after each delivery)
//!   guardian verify --id N
//!
//! Each `dkg` run moves the ceremony on as far as the files in `<dir>/dkg/inbox/` allow:
//!  1. writes `outbox/round1-from-N.json`: send it to every other guardian (public).
//!  2. once `inbox/` holds every other guardian's round-1 file: writes one
//!     `outbox/round2-from-N-to-M.json` per other guardian M. Each holds a secret share for M:
//!     send it ONLY to guardian M, over a private channel, and delete it once delivered.
//!  3. once `inbox/` holds `round2-from-M-to-N.json` from every other guardian: writes this
//!     guardian's key share `keys/guardian-N.key` (mode 600) and the shared public key package
//!     `keys/frost-pubkeys.json`. Nothing else secret is kept.
//!
//! `verify` checks this machine's key share, public keys and `keys/mint.ufvk` (made once by the
//! processor host from frost-pubkeys.json) against each other, writes `outbox/verify-N.json`,
//! and compares it with the other guardians' statements in `inbox/`. When all three agree it
//! deletes everything from the ceremony except its own `outbox/verify-N.json`.
//!
//! Every file is an [`Envelope`] naming its sender, recipient, network and parameters, so a file
//! from another ceremony, network or guardian, or a round-2 file sent to the wrong guardian, is
//! refused.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use zec_frost::{
    MAX_SIGNERS, MIN_SIGNERS,
    redpallas::{
        Identifier,
        keys::{KeyPackage, PublicKeyPackage, dkg},
    },
};

use crate::{Args, check_ufvk, ident, key_path, keys_dir, read_json, write_json};

#[derive(Serialize, Deserialize)]
struct Envelope<T> {
    /// "round1", "round2" or "verify".
    kind: String,
    /// "regtest" or "MAINNET".
    network: String,
    from: u16,
    /// Round 2 only: the one guardian this package is for.
    to: Option<u16>,
    threshold: u16,
    participants: u16,
    package: T,
}

/// What `verify` publishes for the other guardians to compare.
#[derive(Serialize, Deserialize, PartialEq, Eq, Debug, Clone)]
struct Statement {
    group_key: String,
    /// SHA-256 of the canonical JSON of the public key package.
    pubkeys_sha256: String,
    ufvk: String,
    mint_address: String,
}

fn ceremony_dir(args: &Args) -> PathBuf {
    args.dir.join("dkg")
}
fn state_dir(args: &Args) -> PathBuf {
    ceremony_dir(args).join("state")
}
fn inbox(args: &Args) -> PathBuf {
    ceremony_dir(args).join("inbox")
}
fn outbox(args: &Args) -> PathBuf {
    ceremony_dir(args).join("outbox")
}

fn others(args: &Args) -> impl Iterator<Item = u16> + '_ {
    (1..=MAX_SIGNERS).filter(move |&j| j != args.id)
}

fn network_label() -> String {
    zec_wallet::network::current().label().to_owned()
}

/// Creates the ceremony directories, private to this user.
fn make_dirs(args: &Args) -> Result<()> {
    for d in [ceremony_dir(args), state_dir(args), inbox(args), outbox(args)] {
        fs::create_dir_all(&d)?;
        #[cfg(unix)]
        fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    }
    Ok(())
}

/// A secret file: mode 600, never over an existing one.
fn write_secret_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    zec_wallet::network::write_secret(path, &serde_json::to_string_pretty(value)?)
}

fn envelope<T>(args: &Args, kind: &str, to: Option<u16>, package: T) -> Envelope<T> {
    Envelope {
        kind: kind.into(),
        network: network_label(),
        from: args.id,
        to,
        threshold: MIN_SIGNERS,
        participants: MAX_SIGNERS,
        package,
    }
}

/// Reads `path` and checks it is the expected kind, from `from`, to `to`, for this ceremony.
fn open<T: DeserializeOwned>(path: &Path, kind: &str, from: u16, to: Option<u16>) -> Result<T> {
    let e: Envelope<T> = read_json(path)?;
    let name = path.display();
    ensure!(e.kind == kind, "{name}: a {} file, expected {kind}", e.kind);
    ensure!(e.network == network_label(), "{name}: made on {}, this is {}", e.network, network_label());
    ensure!(e.from == from, "{name}: from guardian {}, expected {from}", e.from);
    ensure!(e.to == to, "{name}: addressed to {:?}, expected {to:?}", e.to);
    ensure!(
        (e.threshold, e.participants) == (MIN_SIGNERS, MAX_SIGNERS),
        "{name}: a {}-of-{} ceremony, this is {MIN_SIGNERS}-of-{MAX_SIGNERS}",
        e.threshold,
        e.participants
    );
    Ok(e.package)
}

fn round1_name(from: u16) -> String {
    format!("round1-from-{from}.json")
}
fn round2_name(from: u16, to: u16) -> String {
    format!("round2-from-{from}-to-{to}.json")
}

/// The other guardians' round-1 packages, if all are in the inbox; else the missing ids.
fn inbox_round1(args: &Args) -> Result<std::result::Result<BTreeMap<Identifier, dkg::round1::Package>, Vec<u16>>> {
    let missing: Vec<u16> = others(args).filter(|&j| !inbox(args).join(round1_name(j)).exists()).collect();
    if !missing.is_empty() {
        return Ok(Err(missing));
    }
    let packages = others(args)
        .map(|j| Ok((ident(j)?, open(&inbox(args).join(round1_name(j)), "round1", j, None)?)))
        .collect::<Result<_>>()?;
    Ok(Ok(packages))
}

/// Round-2 files in the inbox that are addressed to another guardian: they hold someone else's
/// secret share and must not be here.
fn misrouted_round2(args: &Args) -> Result<Vec<String>> {
    let mut bad = vec![];
    for entry in fs::read_dir(inbox(args))? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.starts_with("round2-") && !name.ends_with(&format!("-to-{}.json", args.id)) {
            bad.push(name);
        }
    }
    Ok(bad)
}

pub fn dkg(args: &Args) -> Result<()> {
    ensure!(
        (args.threshold, args.participants) == (Some(MIN_SIGNERS), Some(MAX_SIGNERS)),
        "pass --threshold {MIN_SIGNERS} --participants {MAX_SIGNERS} (the processor signs {MIN_SIGNERS}-of-{MAX_SIGNERS} only)"
    );
    ensure!(
        !key_path(args).exists(),
        "{} exists: this guardian already holds a key share, and a DKG never replaces one",
        key_path(args).display()
    );
    make_dirs(args)?;
    let (r1_secret, r2_secret) = (state_dir(args).join("round1-secret.json"), state_dir(args).join("round2-secret.json"));
    let me = args.id;
    let peers = others(args).map(|j| j.to_string()).collect::<Vec<_>>().join(" and ");
    let bad = misrouted_round2(args)?;
    ensure!(
        bad.is_empty(),
        "inbox holds round-2 files addressed to other guardians: {bad:?}. They contain another \
         guardian's secret share: delete them here and tell the sender"
    );

    if !r1_secret.exists() && !r2_secret.exists() {
        ensure!(
            !outbox(args).join(round1_name(me)).exists(),
            "round 1 was published but its secret is gone ({}): start the whole ceremony again \
             (every guardian deletes its {} directory)",
            r1_secret.display(),
            ceremony_dir(args).display()
        );
        let (secret, package) = dkg::part1(ident(me)?, MAX_SIGNERS, MIN_SIGNERS, rand::thread_rng())?;
        write_secret_json(&r1_secret, &secret)?;
        write_json(&outbox(args).join(round1_name(me)), &envelope(args, "round1", None, package))?;
        println!("guardian {me}: round 1 done.");
        println!("  send {} to guardians {peers}", outbox(args).join(round1_name(me)).display());
        println!("  put their round1-from-*.json files in {}, then run this again", inbox(args).display());
        return Ok(());
    }

    if r1_secret.exists() {
        let packages = match inbox_round1(args)? {
            Ok(p) => p,
            Err(missing) => {
                println!("guardian {me}: waiting for round-1 files from guardians {missing:?} in {}", inbox(args).display());
                return Ok(());
            }
        };
        let (secret, out) = dkg::part2(read_json(&r1_secret)?, &packages)?;
        write_secret_json(&r2_secret, &secret)?;
        for (to, package) in out {
            let to = others(args).find(|&j| ident(j).ok() == Some(to)).context("unknown recipient")?;
            write_secret_json(&outbox(args).join(round2_name(me, to)), &envelope(args, "round2", Some(to), package))?;
        }
        fs::remove_file(&r1_secret)?;
        println!("guardian {me}: round 2 done.");
        for j in others(args) {
            println!(
                "  send {} ONLY to guardian {j} (it is a secret share for guardian {j}; private channel)",
                outbox(args).join(round2_name(me, j)).display()
            );
        }
        println!("  put round2-from-*-to-{me}.json from the others in {}, then run this again", inbox(args).display());
        return Ok(());
    }

    // Round 3: our key share.
    let missing: Vec<u16> = others(args).filter(|&j| !inbox(args).join(round2_name(j, me)).exists()).collect();
    if !missing.is_empty() {
        println!("guardian {me}: waiting for round-2 files from guardians {missing:?} in {}", inbox(args).display());
        return Ok(());
    }
    let r1 = inbox_round1(args)?.map_err(|m| anyhow::anyhow!("round-1 files from {m:?} vanished from the inbox"))?;
    let r2: BTreeMap<Identifier, dkg::round2::Package> = others(args)
        .map(|j| Ok((ident(j)?, open(&inbox(args).join(round2_name(j, me)), "round2", j, Some(me))?)))
        .collect::<Result<_>>()?;
    let (key_package, pubkeys): (KeyPackage, PublicKeyPackage) = dkg::part3(&read_json(&r2_secret)?, &r1, &r2)?;
    let pubkeys_path = keys_dir(args).join("frost-pubkeys.json");
    if pubkeys_path.exists() {
        let existing: PublicKeyPackage = read_json(&pubkeys_path)?;
        ensure!(existing == pubkeys, "{} exists and differs from this ceremony's", pubkeys_path.display());
    }
    write_secret_json(&key_path(args), &key_package)?;
    if !pubkeys_path.exists() {
        write_json(&pubkeys_path, &pubkeys)?;
    }
    fs::remove_file(&r2_secret)?;
    for j in others(args) {
        let _ = fs::remove_file(inbox(args).join(round2_name(j, me))); // secret shares for us: used
    }
    println!("guardian {me}: key share written to {} (mode 600)", key_path(args).display());
    println!("  group key {}", hex::encode(zec_frost::group_key_bytes(&pubkeys)?));
    println!("  next: the processor host makes mint.ufvk from {} (`zec-processor make-ufvk`);", pubkeys_path.display());
    println!("  copy that mint.ufvk to {}, then run `guardian verify`.", keys_dir(args).display());
    println!(
        "  {}/round2-from-{me}-to-* are secret shares for the others: delete them once delivered.",
        outbox(args).display()
    );
    Ok(())
}

fn statement(args: &Args) -> Result<Statement> {
    let keys = check_ufvk(args)?;
    let ufvk = zec_wallet::frost::read_ufvk(&keys_dir(args).join("mint.ufvk"))?;
    Ok(Statement {
        group_key: hex::encode(zec_frost::group_key_bytes(&keys.pubkeys)?),
        pubkeys_sha256: hex::encode(Sha256::digest(serde_json::to_vec(&keys.pubkeys)?)),
        ufvk: ufvk.encode(&zec_wallet::network::params()),
        mint_address: keys.first_address,
    })
}

pub fn verify(args: &Args) -> Result<()> {
    let mine = statement(args)?;
    let me = args.id;
    make_dirs(args)?;
    let out = outbox(args).join(format!("verify-{me}.json"));
    if out.exists() {
        fs::remove_file(&out)?;
    }
    write_json(&out, &envelope(args, "verify", None, mine.clone()))?;
    println!("guardian {me}: key share, frost-pubkeys.json and mint.ufvk are consistent");
    println!("  group key      {}", mine.group_key);
    println!("  pubkeys sha256 {}", mine.pubkeys_sha256);
    println!("  mint address   {}", mine.mint_address);

    let marker = ceremony_dir(args).join("verified.json");
    if marker.exists() {
        let agreed: Statement = read_json(&marker)?;
        ensure!(
            agreed == mine,
            "keys changed since all guardians agreed ({}): do not fund this reserve",
            marker.display()
        );
        println!("all {MAX_SIGNERS} guardians already agreed on these keys ({})", marker.display());
        return Ok(());
    }

    let mut missing = vec![];
    for j in others(args) {
        let path = inbox(args).join(format!("verify-{j}.json"));
        if !path.exists() {
            missing.push(j);
            continue;
        }
        let theirs: Statement = open(&path, "verify", j, None)?;
        if theirs != mine {
            bail!(
                "guardian {j} DISAGREES: its group key {} / pubkeys {} / UFVK {} differ from ours. Do not \
                 fund this reserve; redo the ceremony.",
                theirs.group_key,
                theirs.pubkeys_sha256,
                theirs.ufvk
            );
        }
        println!("  guardian {j}: agrees");
    }
    if !missing.is_empty() {
        println!(
            "  send {} to the other guardians; waiting for verify-*.json from guardians {missing:?} in {}",
            out.display(),
            inbox(args).display()
        );
        return Ok(());
    }
    // Done: keep only our statement (the others may still need it) and the agreed statement.
    write_json(&marker, &mine)?;
    fs::remove_dir_all(state_dir(args))?;
    fs::remove_dir_all(inbox(args))?;
    for entry in fs::read_dir(outbox(args))? {
        let path = entry?.path();
        if path != out && path != marker {
            fs::remove_file(path)?;
        }
    }
    println!(
        "all {MAX_SIGNERS} guardians agree on the group key and the UFVK; cleared the ceremony files \
         (kept {} for anyone who has not received it)",
        out.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(root: &Path, id: u16) -> Args {
        Args {
            cmd: vec![],
            id,
            threshold: Some(MIN_SIGNERS),
            participants: Some(MAX_SIGNERS),
            dir: root.join(format!("m{id}")),
            mint: String::new(),
            listen: None,
        }
    }

    fn deliver(from: &Args, to: &Args, name: &str) {
        fs::copy(outbox(from).join(name), inbox(to).join(name)).unwrap();
    }

    #[test]
    fn three_machine_ceremony() {
        let root = std::env::temp_dir().join(format!("guardian-dkg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let m: Vec<Args> = (1..=3).map(|i| machine(&root, i)).collect();

        for a in &m {
            dkg(a).unwrap(); // round 1
        }
        for a in &m {
            for b in m.iter().filter(|b| b.id != a.id) {
                deliver(a, b, &round1_name(a.id));
            }
        }
        for a in &m {
            dkg(a).unwrap(); // round 2
        }
        // A round-2 package for guardian 2 that ends up at guardian 3 is refused.
        deliver(&m[0], &m[2], &round2_name(1, 2));
        assert!(dkg(&m[2]).unwrap_err().to_string().contains("addressed to other guardians"));
        fs::remove_file(inbox(&m[2]).join(round2_name(1, 2))).unwrap();
        for a in &m {
            for b in m.iter().filter(|b| b.id != a.id) {
                deliver(a, b, &round2_name(a.id, b.id));
            }
        }
        for a in &m {
            dkg(a).unwrap(); // key shares
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(key_path(a)).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        assert!(dkg(&m[0]).unwrap_err().to_string().contains("already holds a key share"));

        // The processor host makes one UFVK from the public key package; everyone gets it.
        let pubkeys: PublicKeyPackage = read_json(&keys_dir(&m[0]).join("frost-pubkeys.json")).unwrap();
        let ufvk = zec_wallet::frost::frost_ufvk(zec_frost::group_key_bytes(&pubkeys).unwrap()).unwrap();
        for a in &m {
            fs::write(keys_dir(a).join("mint.ufvk"), ufvk.encode(&zec_wallet::network::params())).unwrap();
            verify(a).unwrap();
        }
        for a in &m {
            for b in m.iter().filter(|b| b.id != a.id) {
                deliver(a, b, &format!("verify-{}.json", a.id));
            }
        }
        for a in &m {
            verify(a).unwrap();
            assert!(ceremony_dir(a).join("verified.json").exists());
            assert!(!state_dir(a).exists() && !inbox(a).exists(), "ceremony files cleared");
        }
        let _ = fs::remove_dir_all(&root);
    }
}
