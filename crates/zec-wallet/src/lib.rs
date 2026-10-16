//! Regtest Zcash wallet shared by `devwallet` and (later) zec-processor's reserve wallet.
//! NOT for real funds: network parameters are always `regtest::regtest_network()`.
//!
//! Talks to Zebra's built-in light-wallet gRPC server (plaintext) and keeps its state in a
//! zcash_client_sqlite database next to the seed file.
pub mod regtest;

mod cache;

use std::{convert::Infallible, fs, path::Path};

use anyhow::{Context, Result, anyhow, bail};
use rand::{RngCore, rngs::OsRng};
use secrecy::SecretVec;
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, WalletRead, WalletWrite,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            propose_standard_transfer_to_address,
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
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{ShieldedPool, local_consensus::LocalNetwork, value::Zatoshis};
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
        let amount = Zatoshis::from_u64(zats).map_err(|_| anyhow!("amount out of range: {zats}"))?;

        let proposal = propose_standard_transfer_to_address::<_, _, Infallible>(
            &mut self.db,
            &params,
            StandardFeeRule::Zip317,
            self.account_id,
            CONFIRMATIONS,
            &to,
            amount,
            None,
            None,
            ShieldedPool::Ironwood,
            None,
            None,
        )
        .map_err(|e| anyhow!("cannot build proposal: {e}"))?;

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

        let mut client = connect(&self.lightwalletd).await?;
        let mut sent = vec![];
        for txid in txids {
            let tx = self.db.get_transaction(txid)?.context("created transaction not in wallet DB")?;
            let mut data = vec![];
            tx.write(&mut data)?;
            let resp = client.send_transaction(RawTransaction { data, height: 0 }).await?.into_inner();
            if resp.error_code != 0 {
                bail!("node rejected {txid}: {} (code {})", resp.error_message, resp.error_code);
            }
            sent.push(txid);
        }
        Ok(sent)
    }
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
    fn big_endian_index() {
        assert_eq!(be_index_to_u32(&[0; 11]), Some(0));
        assert_eq!(be_index_to_u32(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]), Some(258));
        assert_eq!(be_index_to_u32(&[0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]), None);
    }
}
