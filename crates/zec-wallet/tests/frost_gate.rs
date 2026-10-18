//! Phase 4 gate: a withdrawal PCZT from a wallet whose spend key is a 2-of-3 FROST group key,
//! built by the Phase 2 pipeline, signed with alpha-rerandomized FROST, proven and extracted,
//! then broadcast and mined so the node validates it in full.
//!
//! Needs the regtest devnet (zebrad running, user wallet funded, seed in devnet/keys/):
//!   cargo test -p zec-wallet --test frost_gate -- --ignored --nocapture
use std::{collections::BTreeMap, path::PathBuf, process::Command};

use zec_frost::redpallas as frost;
use zec_wallet::{Wallet, frost as pczt_frost};

const LWD: &str = "http://127.0.0.1:9067";

fn devnet() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../devnet")
}

fn mine(n: u32) {
    let out = Command::new(devnet().join("mine.sh")).arg(n.to_string()).output().unwrap();
    assert!(out.status.success(), "mine.sh failed: {out:?}");
}

#[tokio::test]
#[ignore = "needs the regtest devnet: zebrad on 127.0.0.1:9067/18232 and a funded devnet/user-wallet.seed"]
async fn frost_signed_withdrawal_verifies() -> anyhow::Result<()> {
    // 2-of-3 FROST keys (trusted dealer is fine for the gate); group key = Orchard ak.
    let mut rng = rand::thread_rng();
    let (shares, pubkeys) = frost::keys::generate_with_dealer(
        zec_frost::MAX_SIGNERS,
        zec_frost::MIN_SIGNERS,
        frost::keys::IdentifierList::Default,
        &mut rng,
    )?;
    let kps: BTreeMap<_, _> =
        shares.into_iter().map(|(id, s)| (id, frost::keys::KeyPackage::try_from(s).unwrap())).collect();
    let ufvk = pczt_frost::frost_ufvk(zec_frost::group_key_bytes(&pubkeys)?)?;
    let ufvk_str = ufvk.encode(&zec_wallet::regtest::regtest_network());

    // A view-only wallet for that UFVK: no spending key exists anywhere.
    let dir = std::env::temp_dir().join(format!("zec-frost-gate-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let mut mint = Wallet::open_or_import_ufvk(&ufvk_str, &dir.join("frost.sqlite"), LWD).await?;
    let mint_addr = mint.address()?;
    println!("FROST wallet address: {mint_addr}");

    // Fund it from the devnet user wallet and confirm.
    let mut user = Wallet::open_or_create(
        &devnet().join("keys/user-wallet.seed"),
        &devnet().join("user-wallet.sqlite"),
        LWD,
    )
    .await?;
    user.sync().await?;
    let funding = user.send(&mint_addr, 60_000).await?;
    println!("funded with 60000 zat: {funding:?}");
    mine(1);
    let tip = mint.sync().await?;
    let bal = mint.balance()?;
    println!("FROST wallet at height {tip}: {bal:?}");
    assert_eq!(bal.ironwood.spendable, 60_000);

    // Phase 2 pipeline: propose + PCZT, paying the user back 20000 zat.
    let user_addr = user.address()?;
    let built = mint.build_pczt(&user_addr, 20_000)?;
    println!("PCZT built: fee {} zat, expiry height {}", built.fee, built.expiry_height);

    // FROST-sign every spend that needs it, with randomizer = that spend's alpha.
    let sighash = pczt_frost::shielded_sighash(&built.pczt)?;
    let spends = pczt_frost::spends_to_sign(&built.pczt)?;
    assert!(!spends.is_empty());
    let signers: Vec<_> = kps.keys().copied().take(2).collect();
    let mut sigs = vec![];
    for spend in &spends {
        assert_eq!(zec_frost::randomized_key(&pubkeys, &spend.alpha)?, spend.rk, "ak + [alpha]G == rk");
        let mut nonces = BTreeMap::new();
        let mut commitments = BTreeMap::new();
        for id in &signers {
            let (n, c) = frost::round1::commit(kps[id].signing_share(), &mut rng);
            nonces.insert(*id, n);
            commitments.insert(*id, c);
        }
        let package = frost::SigningPackage::new(commitments, &sighash);
        let mut shares = BTreeMap::new();
        for id in &signers {
            shares.insert(*id, zec_frost::sign_share(&package, &nonces[id], &kps[id], &spend.alpha)?);
        }
        sigs.push((spend.pool, spend.index, zec_frost::aggregate(&package, &shares, &pubkeys, &spend.alpha)?));
    }
    println!("FROST-signed {} spend(s): {:?}", spends.len(), spends.iter().map(|s| (s.pool, s.index)).collect::<Vec<_>>());
    let signed = pczt_frost::apply_spend_auth_signatures(built.pczt, &sigs)?;

    // Prove + extract (extraction verifies proofs and signatures), then let the node judge it.
    let txid = mint.prove_and_extract(signed)?;
    println!("extracted and verified: {txid}");
    mint.broadcast(txid).await?;
    println!("node accepted {txid} into the mempool");
    mine(1);
    mint.sync().await?;
    let mined = mint.tx_mined_height(txid)?;
    println!("mined at height {mined:?}; FROST wallet now {:?}", mint.balance()?.ironwood);
    assert!(mined.is_some());
    Ok(())
}
