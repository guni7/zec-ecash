//! Regtest Zcash wallet shared by `devwallet` and (later) zec-processor's reserve wallet.
//! NOT for real funds: network parameters are always `regtest::regtest_network()`.
//!
//! Talks to Zebra's built-in light-wallet gRPC server (plaintext) and keeps its state in a
//! zcash_client_sqlite database next to the seed file.
pub mod regtest;
mod signer;

mod cache;

pub use pczt::{self, Pczt};
pub use signer::{LocalSigner, Signer};

use std::{convert::Infallible, fs, path::Path};

use anyhow::{Context, Result, anyhow, bail};
use rand::{RngCore, rngs::OsRng};
use secrecy::SecretVec;
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, InputSource, WalletRead, WalletWrite,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_pczt_from_proposal, create_proposed_transactions,
            extract_and_store_transaction_from_pczt, propose_standard_transfer_to_address,
        },
    },
    fees::StandardFeeRule,
    proto::service::{BlockId, RawTransaction, compact_tx_streamer_client::CompactTxStreamerClient},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{
    address::Address,
    keys::{UnifiedAddressRequest, UnifiedSpendingKey},
};
use pczt::roles::prover::Prover;
use zcash_primitives::transaction::builder::{BundlePadding, cached_orchard_proving_key};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    consensus::{BlockHeight, BranchId},
    local_consensus::LocalNetwork,
    value::Zatoshis,
};
use zip32::AccountId;

pub use zcash_protocol::TxId;

/// Notes are spendable after 1 confirmation (ZIP 315's default is 3 or 10), so one
/// `./devnet/mine.sh 1` after a send is enough. Coinbase maturity (100) is consensus, not this.
const CONFIRMATIONS: ConfirmationsPolicy = ConfirmationsPolicy::MIN;
const SYNC_BATCH_SIZE: u32 = 1000;

type Db = WalletDb<rusqlite::Connection, LocalNetwork, SystemClock, OsRng>;
type DbAccountId = <Db as WalletRead>::AccountId;

/// Writes a new random 32-byte seed (hex) to `seed_path`. Refuses to overwrite one.
pub fn create_seed(seed_path: &Path) -> Result<()> {
    if seed_path.exists() {
        bail!(
            "{} already exists; delete it first if you really want a new wallet",
            seed_path.display()
        );
    }
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    if let Some(dir) = seed_path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(seed_path, hex::encode(seed))?;
    Ok(())
}

/// The wallet's address straight from the seed, without a DB or a node.
pub fn seed_address(seed_path: &Path) -> Result<String> {
    derive_address(&read_seed(seed_path)?)
}

fn read_seed(seed_path: &Path) -> Result<Vec<u8>> {
    let seed_hex = fs::read_to_string(seed_path)
        .with_context(|| format!("no {}; create it with `devwallet new` first", seed_path.display()))?;
    hex::decode(seed_hex.trim()).context("seed file is not hex")
}

fn spending_key(seed: &[u8]) -> Result<UnifiedSpendingKey> {
    UnifiedSpendingKey::from_seed(&regtest::regtest_network(), seed, AccountId::ZERO)
        .map_err(|e| anyhow!("key derivation failed: {e:?}"))
}

/// Default Orchard-format-receiver UA of account 0 (Ironwood shares the receiver format).
fn derive_address(seed: &[u8]) -> Result<String> {
    let (ua, _) = spending_key(seed)?
        .to_unified_full_viewing_key()
        .default_address(UnifiedAddressRequest::ORCHARD)
        .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
    Ok(ua.encode(&regtest::regtest_network()))
}

/// Per-pool balance in zats. `pending` = total - spendable (unconfirmed, change, immature).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PoolBalance {
    pub spendable: u64,
    pub pending: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Balances {
    /// Chain height the wallet has scanned to.
    pub height: u32,
    pub ironwood: PoolBalance,
    pub orchard: PoolBalance,
    pub sapling: PoolBalance,
    pub transparent: PoolBalance,
}

impl Balances {
    pub fn total(&self) -> PoolBalance {
        [self.ironwood, self.orchard, self.sapling, self.transparent]
            .iter()
            .fold(PoolBalance::default(), |a, p| PoolBalance {
                spendable: a.spendable + p.spendable,
                pending: a.pending + p.pending,
            })
    }
}

/// A non-change Ironwood note the wallet has received in a mined transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedNote {
    /// Display (reversed-hex) txid.
    pub txid: String,
    pub action_index: u32,
    pub value: u64,
    /// Diversifier index of the receiving address; `None` if it isn't one of ours or is
    /// outside the u32 range used for deposit addresses.
    pub diversifier_index: Option<u32>,
    pub mined_height: u32,
}

pub struct Wallet {
    db: Db,
    db_path: std::path::PathBuf,
    seed: Vec<u8>,
    account_id: DbAccountId,
    lightwalletd: String,
}

impl Wallet {
    /// Opens the wallet DB at `db_path`, creating it and its single account on first use.
    ///
    /// Async because the first run fetches the account birthday's tree state from the node.
    pub async fn open_or_create(seed_path: &Path, db_path: &Path, lightwalletd: &str) -> Result<Self> {
        let seed = read_seed(seed_path)?;
        let mut db = WalletDb::for_path(db_path, regtest::regtest_network(), SystemClock, OsRng)
            .with_context(|| format!("cannot open {}", db_path.display()))?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.clone())))
            .map_err(|e| anyhow!("wallet DB migration failed: {e}"))?;

        let account_id = match db.get_account_ids()?.first() {
            Some(id) => *id,
            None => {
                // Birthday at height 2 (prior chain state = block 1), not genesis: sync::run
                // fetches the tree state at birthday - 1, and Zebra rejects `height: 0` in a
                // BlockId as "unset". Cost: a wallet never sees block 1's coinbase.
                let block1 = connect(lightwalletd)
                    .await?
                    .get_tree_state(BlockId { height: 1, hash: vec![] })
                    .await
                    .context("chain has no block 1 yet; run ./devnet/mine.sh 1")?
                    .into_inner();
                let birthday = AccountBirthday::from_treestate(block1, None)
                    .map_err(|e| anyhow!("bad tree state for block 1: {e:?}"))?;
                db.create_account("zec-wallet", &SecretVec::new(seed.clone()), &birthday, None)?
                    .0
            }
        };

        let wallet = Wallet {
            db,
            db_path: db_path.to_owned(),
            seed,
            account_id,
            lightwalletd: lightwalletd.to_owned(),
        };
        // The DB account must be the same wallet whose address the seed alone gives.
        assert_eq!(
            wallet.address()?,
            derive_address(&wallet.seed)?,
            "wallet DB account does not match the seed"
        );
        Ok(wallet)
    }

    /// The account's default address (uregtest1..., Orchard-format receiver).
    pub fn address(&self) -> Result<String> {
        let account = self.db.get_account(self.account_id)?.context("wallet account missing")?;
        let (ua, _) = account
            .ufvk()
            .context("account has no UFVK")?
            .default_address(UnifiedAddressRequest::ORCHARD)
            .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
        Ok(ua.encode(&regtest::regtest_network()))
    }

    /// Derives the Orchard-format-receiver address at diversifier `index` and registers it with
    /// the wallet, so notes it receives are linked to it (`address_id`) when scanned.
    pub fn address_at(&mut self, index: u32) -> Result<String> {
        let ua = self
            .db
            .get_address_for_index(self.account_id, index.into(), UnifiedAddressRequest::ORCHARD)?
            .with_context(|| format!("no Orchard-format address at diversifier index {index}"))?;
        Ok(ua.encode(&regtest::regtest_network()))
    }

    /// All non-change Ironwood notes received in mined transactions, oldest first.
    ///
    /// zcash_client_sqlite has no public API listing received notes with their receiving
    /// address, so this reads its tables directly (read-only). The diversifier index comes from
    /// the linked `addresses` row when the address was registered via [`Self::address_at`],
    /// otherwise it is recovered from the note's diversifier with the external Orchard IVK.
    pub fn received_notes(&self) -> Result<Vec<ReceivedNote>> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let account = self.db.get_account(self.account_id)?.context("wallet account missing")?;
        let ivk = account
            .ufvk()
            .and_then(|k| k.orchard())
            .context("account has no Orchard-format viewing key")?
            .to_ivk(orchard::keys::Scope::External);

        let mut stmt = conn.prepare(
            "SELECT t.txid, n.action_index, n.value, n.diversifier, a.diversifier_index_be,
                    t.mined_height
             FROM ironwood_received_notes n
             JOIN transactions t ON t.id_tx = n.transaction_id
             JOIN accounts acc ON acc.id = n.account_id
             LEFT JOIN addresses a ON a.id = n.address_id
             WHERE acc.uuid = ?1 AND n.is_change = 0 AND t.mined_height IS NOT NULL
             ORDER BY t.mined_height, n.id",
        )?;
        let rows = stmt.query_map([self.account_id.expose_uuid().as_bytes()], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, Option<Vec<u8>>>(4)?,
                r.get::<_, u32>(5)?,
            ))
        })?;

        let mut notes = vec![];
        for row in rows {
            let (txid, action_index, value, diversifier, index_be, mined_height) = row?;
            let index = match index_be {
                Some(be) => be_index_to_u32(&be),
                None => recover_index(&ivk, &diversifier),
            };
            notes.push(ReceivedNote {
                txid: TxId::from_bytes(txid.try_into().map_err(|_| anyhow!("bad txid length"))?)
                    .to_string(),
                action_index,
                value: value.try_into().context("negative note value")?,
                diversifier_index: index,
                mined_height,
            });
        }
        Ok(notes)
    }

    /// Scans to the chain tip; returns the tip height.
    pub async fn sync(&mut self) -> Result<u32> {
        let mut client = connect(&self.lightwalletd).await?;
        let cache = cache::MemBlockCache::default();
        zcash_client_backend::sync::run(
            &mut client,
            &regtest::regtest_network(),
            &cache,
            &mut self.db,
            SYNC_BATCH_SIZE,
        )
        .await
        .map_err(|e| anyhow!("sync failed: {e}"))?;
        Ok(self.db.chain_height()?.context("no chain tip after sync")?.into())
    }

    /// Balances as of the last sync.
    pub fn balance(&self) -> Result<Balances> {
        let summary = self
            .db
            .get_wallet_summary(CONFIRMATIONS)?
            .context("wallet has no summary yet; sync first")?;
        let bal = summary
            .account_balances()
            .get(&self.account_id)
            .context("account missing from wallet summary")?;
        let pool = |b: &zcash_client_backend::data_api::Balance| PoolBalance {
            spendable: b.spendable_value().into(),
            pending: u64::from(b.total()) - u64::from(b.spendable_value()),
        };
        Ok(Balances {
            height: summary.chain_tip_height().into(),
            ironwood: pool(bal.ironwood_balance()),
            orchard: pool(bal.orchard_balance()),
            sapling: pool(bal.sapling_balance()),
            transparent: pool(&bal.unshielded_balance()),
        })
    }

    /// Builds, proves, signs and broadcasts a payment; change goes to Ironwood.
    /// Returns the txids (a proposal can need more than one transaction). Sync first.
    pub async fn send(&mut self, to: &str, zats: u64) -> Result<Vec<TxId>> {
        let params = regtest::regtest_network();
        let to = Address::decode(&params, to).with_context(|| format!("not a regtest address: {to}"))?;
        let proposal = self.propose(&to, zats)?;

        // Sapling provers are required by the builder API even for Ironwood-only transactions.
        let prover = LocalTxProver::bundled();
        let txids = create_proposed_transactions::<_, _, Infallible, _, Infallible, _>(
            &mut self.db,
            &params,
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(spending_key(&self.seed)?),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| anyhow!("cannot create transaction: {e}"))?;

        let mut sent = vec![];
        for txid in txids {
            self.broadcast(txid).await?;
            sent.push(txid);
        }
        Ok(sent)
    }

    /// A standard ZIP 317 transfer proposal from this wallet's account; change goes to Ironwood.
    fn propose(&mut self, to: &Address, zats: u64) -> Result<Proposal> {
        let amount = Zatoshis::from_u64(zats).map_err(|_| anyhow!("amount out of range: {zats}"))?;
        propose_standard_transfer_to_address::<_, _, Infallible>(
            &mut self.db,
            &regtest::regtest_network(),
            StandardFeeRule::Zip317,
            self.account_id,
            CONFIRMATIONS,
            to,
            amount,
            None,
            None,
            ShieldedPool::Ironwood,
            None,
            None,
        )
        .map_err(|e| anyhow!("cannot build proposal: {e}"))
    }

    /// The ZIP 317 fee a payment of `zats` to `to` would cost right now. Builds nothing.
    pub fn quote_fee(&mut self, to: &str, zats: u64) -> Result<u64> {
        let to = validate_withdrawal_address(to)?;
        let proposal = self.propose(&to, zats)?;
        Ok(proposal_fee(&proposal))
    }

    /// Proposes a payment and turns it into an unsigned, unproven PCZT (the mint never holds a
    /// spending key here; a [`Signer`] authorizes it). Nothing is stored in the wallet yet.
    pub fn build_pczt(&mut self, to: &str, zats: u64) -> Result<BuiltPczt> {
        let to = validate_withdrawal_address(to)?;
        let proposal = self.propose(&to, zats)?;
        let fee = proposal_fee(&proposal);
        let pczt = create_pczt_from_proposal::<_, _, Infallible, _, Infallible, _>(
            &mut self.db,
            &regtest::regtest_network(),
            self.account_id,
            OvkPolicy::Sender,
            &proposal,
            None,
            BundlePadding::DEFAULT,
        )
        .map_err(|e| anyhow!("cannot create PCZT: {e}"))?;
        let expiry_height = *pczt.global().expiry_height();
        Ok(BuiltPczt { pczt, fee, expiry_height })
    }

    /// Proves a signed PCZT, then extracts the transaction, verifies it, and stores it in the
    /// wallet (its notes count as spent from now on). Returns the txid. Does not broadcast.
    pub fn prove_and_extract(&mut self, signed: Pczt) -> Result<TxId> {
        let branch = BranchId::try_from(*signed.global().consensus_branch_id())
            .map_err(|e| anyhow!("PCZT has an invalid consensus branch: {e}"))?;
        let version = orchard_circuit_version(branch)?;
        // One Orchard proving key serves both pools post-NU6.3; cached after the first build.
        let pk = cached_orchard_proving_key(version);
        let (has_orchard, has_ironwood) =
            (!signed.orchard().actions().is_empty(), !signed.ironwood().actions().is_empty());
        let mut prover = Prover::new(signed);
        if has_orchard {
            prover = prover.create_orchard_proof(pk).map_err(|e| anyhow!("Orchard proof: {e:?}"))?;
        }
        if has_ironwood {
            prover = prover.create_ironwood_proof(pk).map_err(|e| anyhow!("Ironwood proof: {e:?}"))?;
        }
        let proven = prover.finish();
        let vk = orchard_verifying_key(version);
        extract_and_store_transaction_from_pczt::<_, NoteRef>(&mut self.db, proven, None, Some(vk))
            .map_err(|e| anyhow!("cannot extract transaction: {e}"))
    }

    /// Sends a transaction stored in the wallet DB to the node. Safe to repeat.
    /// (`&mut self` so the future stays `Send`: the DB connection is not `Sync`.)
    pub async fn broadcast(&mut self, txid: TxId) -> Result<()> {
        let tx = self.db.get_transaction(txid)?.context("transaction not in wallet DB")?;
        let mut data = vec![];
        tx.write(&mut data)?;
        let resp = connect(&self.lightwalletd)
            .await?
            .send_transaction(RawTransaction { data, height: 0 })
            .await?
            .into_inner();
        if resp.error_code != 0 {
            bail!("node rejected {txid}: {} (code {})", resp.error_message, resp.error_code);
        }
        Ok(())
    }

    /// Height at which the wallet has seen `txid` mined, as of the last sync.
    pub fn tx_mined_height(&self, txid: TxId) -> Result<Option<u32>> {
        Ok(self.db.get_tx_height(txid)?.map(u32::from))
    }
}

/// Parses a txid in its usual display form (byte-reversed hex).
pub fn parse_txid(s: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(s.trim())
        .context("txid is not hex")?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

/// A PCZT ready for the Signer, plus what the processor records about it.
pub struct BuiltPczt {
    pub pczt: Pczt,
    pub fee: u64,
    /// 0 means the transaction never expires.
    pub expiry_height: u32,
}

type NoteRef = <Db as InputSource>::NoteRef;
type Proposal = zcash_client_backend::proposal::Proposal<StandardFeeRule, NoteRef>;

fn proposal_fee(proposal: &Proposal) -> u64 {
    proposal.steps().iter().map(|s| u64::from(s.balance().fee_required())).sum()
}

/// Accepts only regtest addresses with an Orchard-format receiver, which pay into Ironwood:
/// a unified address with an Orchard receiver. Transparent, Sapling-only, TEX, other-network
/// and malformed addresses are rejected.
pub fn validate_withdrawal_address(s: &str) -> Result<Address> {
    let params = regtest::regtest_network();
    let addr = Address::decode(&params, s.trim())
        .with_context(|| format!("not a valid regtest Zcash address: {s}"))?;
    match &addr {
        Address::Unified(ua) if ua.orchard().is_some() => Ok(addr),
        Address::Unified(_) => bail!("unified address has no Orchard receiver (needed to pay into Ironwood)"),
        Address::Transparent(_) | Address::Tex(_) => bail!("transparent addresses are not supported; use a shielded unified address"),
        Address::Sapling(_) => bail!("Sapling-only addresses are not supported; use a unified address with an Orchard receiver"),
    }
}

fn orchard_circuit_version(branch: BranchId) -> Result<orchard::circuit::OrchardCircuitVersion> {
    Ok(zcash_primitives::transaction::components::orchard::bundle_version_for_branch(
        branch,
        orchard::ValuePool::Orchard,
    )
    .context("this consensus branch has no Orchard pool")?
    .circuit_version())
}

/// Builds the Orchard proving key for the current regtest consensus branch (a few seconds),
/// so the first withdrawal doesn't pay for it. Later calls hit the cache.
pub fn warm_proving_key() -> Result<()> {
    let params = regtest::regtest_network();
    let branch = BranchId::for_height(&params, BlockHeight::from_u32(1));
    let version = orchard_circuit_version(branch)?;
    cached_orchard_proving_key(version);
    orchard_verifying_key(version);
    Ok(())
}

fn orchard_verifying_key(
    version: orchard::circuit::OrchardCircuitVersion,
) -> &'static orchard::circuit::VerifyingKey {
    static VKS: std::sync::Mutex<Vec<(orchard::circuit::OrchardCircuitVersion, &'static orchard::circuit::VerifyingKey)>> =
        std::sync::Mutex::new(Vec::new());
    let mut vks = VKS.lock().unwrap();
    if let Some((_, vk)) = vks.iter().find(|(v, _)| *v == version) {
        return vk;
    }
    let vk: &'static _ = Box::leak(Box::new(orchard::circuit::VerifyingKey::build(version)));
    vks.push((version, vk));
    vk
}

/// `addresses.diversifier_index_be` is the 11-byte index, big-endian.
fn be_index_to_u32(be: &[u8]) -> Option<u32> {
    let (high, low) = be.split_at(be.len().checked_sub(4)?);
    if high.iter().any(|&b| b != 0) {
        return None;
    }
    Some(u32::from_be_bytes(low.try_into().ok()?))
}

/// Diversifier -> index via the IVK's diversifier key; `None` if the address isn't ours.
fn recover_index(ivk: &orchard::keys::IncomingViewingKey, diversifier: &[u8]) -> Option<u32> {
    let d = orchard::keys::Diversifier::from_bytes(diversifier.try_into().ok()?);
    u32::try_from(ivk.diversifier_index(&ivk.address(d))?).ok()
}

async fn connect(url: &str) -> Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    CompactTxStreamerClient::connect(url.to_owned())
        .await
        .with_context(|| format!("cannot reach light-wallet gRPC at {url}; is zebrad running?"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ivk_and_fvk(seed: &[u8]) -> (orchard::keys::IncomingViewingKey, orchard::keys::FullViewingKey) {
        let fvk = spending_key(seed).unwrap().to_unified_full_viewing_key().orchard().unwrap().clone();
        (fvk.to_ivk(orchard::keys::Scope::External), fvk)
    }

    #[test]
    fn ivk_recovers_diversifier_index() {
        let (ivk, fvk) = ivk_and_fvk(&[7u8; 32]);
        for j in [0u32, 1, 2, 41, 1_000_000] {
            let d = fvk.address_at(j, orchard::keys::Scope::External).diversifier();
            assert_eq!(recover_index(&ivk, d.as_array()), Some(j));
        }
        // Another wallet's address is not ours.
        let (_, other) = ivk_and_fvk(&[8u8; 32]);
        let foreign = other.address_at(1u32, orchard::keys::Scope::External).diversifier();
        assert_eq!(recover_index(&ivk, foreign.as_array()), None);
    }

    #[test]
    fn withdrawal_address_validation() {
        use zcash_keys::keys::ReceiverRequirement::{Omit, Require};
        let params = regtest::regtest_network();
        let ufvk = spending_key(&[9u8; 32]).unwrap().to_unified_full_viewing_key();
        let (full_ua, _) = ufvk.default_address(UnifiedAddressRequest::ALLOW_ALL).unwrap();

        // Accepted: unified addresses with an Orchard receiver.
        assert!(validate_withdrawal_address(&full_ua.encode(&params)).is_ok());
        assert!(validate_withdrawal_address(&derive_address(&[9u8; 32]).unwrap()).is_ok());

        // Rejected: transparent, Sapling-only (plain and unified), wrong network, malformed.
        let t_addr = Address::Transparent(*full_ua.transparent().unwrap()).encode(&params);
        // Sapling diversifiers aren't valid at every index, so ask for one explicitly.
        let sapling_only = UnifiedAddressRequest::custom(Omit, Require, Omit).unwrap();
        let (sapling_ua, _) = ufvk.default_address(sapling_only).unwrap();
        let z_addr = Address::Sapling(*sapling_ua.sapling().unwrap()).encode(&params);
        // Tests only: the same receivers encoded for mainnet, which must not decode on regtest.
        let mainnet = full_ua.encode(&zcash_protocol::consensus::MainNetwork);
        for (what, addr) in [
            ("transparent", t_addr),
            ("Sapling", z_addr),
            ("Sapling-only UA", sapling_ua.encode(&params)),
            ("mainnet UA", mainnet),
            ("malformed", "uregtest1notanaddress".to_owned()),
            ("empty", String::new()),
        ] {
            assert!(validate_withdrawal_address(&addr).is_err(), "{what} must be rejected: {addr}");
        }
    }

    #[test]
    fn txid_display_roundtrip() {
        let txid = TxId::from_bytes([3u8; 32]);
        assert_eq!(parse_txid(&txid.to_string()).unwrap(), txid);
        assert!(parse_txid("abc").is_err());
    }

    #[test]
    fn big_endian_index() {
        assert_eq!(be_index_to_u32(&[0; 11]), Some(0));
        assert_eq!(be_index_to_u32(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]), Some(258));
        assert_eq!(be_index_to_u32(&[0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]), None);
    }
}
