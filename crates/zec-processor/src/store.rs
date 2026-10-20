//! Deposit quote store: one row per mint quote in `zec_deposit_address`, keyed by the
//! diversifier index of its deposit address. All state lives in SQLite, so a restarted
//! processor picks up exactly where it left off.
use std::{path::Path, sync::Mutex};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use zec_wallet::ReceivedNote;

/// Index 0 is the reserve wallet's default address; deposit addresses start above it.
const FIRST_DEPOSIT_INDEX: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub quote_id: String,
    pub diversifier_index: u32,
    pub address: String,
    pub amount_zats: u64,
    pub received_zats: u64,
    pub confirmations: u32,
    pub paid_emitted: bool,
    pub expires_at: u64,
}

pub struct QuoteStore {
    conn: Mutex<Connection>,
}

impl QuoteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).with_context(|| format!("cannot open {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS zec_deposit_address (
                 quote_id          TEXT PRIMARY KEY,
                 diversifier_index INTEGER NOT NULL UNIQUE,
                 address           TEXT NOT NULL,
                 amount_zats       INTEGER NOT NULL,
                 received_zats     INTEGER NOT NULL DEFAULT 0,
                 confirmations     INTEGER NOT NULL DEFAULT 0,
                 paid_emitted      INTEGER NOT NULL DEFAULT 0,
                 expires_at        INTEGER NOT NULL
             );
             -- Notes already credited to a quote, so a re-scan never counts one twice.
             CREATE TABLE IF NOT EXISTS zec_credited_note (
                 txid         TEXT NOT NULL,
                 action_index INTEGER NOT NULL,
                 quote_id     TEXT NOT NULL REFERENCES zec_deposit_address(quote_id),
                 value        INTEGER NOT NULL,
                 mined_height INTEGER NOT NULL,
                 PRIMARY KEY (txid, action_index)
             );
             -- Next diversifier index to hand out. Only ever increases, so an index is never
             -- reused, even if its quote row is later deleted.
             CREATE TABLE IF NOT EXISTS zec_index_counter (
                 id         INTEGER PRIMARY KEY CHECK (id = 0),
                 next_index INTEGER NOT NULL
             );
             -- Withdrawals (melts). State only moves forward:
             -- UNPAID -> BUILT -> SIGNING -> BROADCAST -> MINED, or -> FAILED.
             -- mined_height/mined_block_hash: where the node last had the tx mined (NULL while
             -- unmined, and again after a reorg drops that block).
             -- operator_action: set when the processor gave up on a row and a person must act
             -- (a PAID withdrawal reorged out and expired unmined: the user was never paid).
             CREATE TABLE IF NOT EXISTS zec_withdrawal (
                 quote_id      TEXT PRIMARY KEY,
                 address       TEXT NOT NULL,
                 amount_zats   INTEGER NOT NULL,
                 fee_zats      INTEGER NOT NULL,
                 state         TEXT NOT NULL,
                 pczt_blob     BLOB,
                 txid          TEXT,
                 expiry_height INTEGER,
                 updated_at    INTEGER NOT NULL,
                 mined_height     INTEGER,
                 mined_block_hash TEXT,
                 operator_action  TEXT
             );",
        )?;
        // Databases created before reorg tracking lack the last two columns.
        let has_hash: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('zec_withdrawal') WHERE name = 'mined_block_hash'")?
            .exists([])?;
        if !has_hash {
            conn.execute_batch(
                "ALTER TABLE zec_withdrawal ADD COLUMN mined_height INTEGER;
                 ALTER TABLE zec_withdrawal ADD COLUMN mined_block_hash TEXT;",
            )?;
        }
        let has_action: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('zec_withdrawal') WHERE name = 'operator_action'")?
            .exists([])?;
        if !has_action {
            conn.execute_batch("ALTER TABLE zec_withdrawal ADD COLUMN operator_action TEXT;")?;
        }
        Ok(QuoteStore { conn: Mutex::new(conn) })
    }

    /// Reserves the next diversifier index, derives its address with `derive`, and stores the
    /// quote, all in one transaction. If `derive` fails, nothing is stored and the index stays
    /// unused. Calling again with the same `quote_id` returns the existing quote unchanged.
    pub fn create_quote(
        &self,
        quote_id: &str,
        amount_zats: u64,
        expires_at: u64,
        derive: impl FnOnce(u32) -> Result<String>,
    ) -> Result<Quote> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if let Some(existing) = get_quote(&tx, quote_id)? {
            return Ok(existing);
        }
        let index: u32 = tx
            .query_row("SELECT next_index FROM zec_index_counter WHERE id = 0", [], |r| r.get(0))
            .optional()?
            .unwrap_or(FIRST_DEPOSIT_INDEX);
        let next = index.checked_add(1).context("diversifier indexes exhausted")?;
        tx.execute(
            "INSERT INTO zec_index_counter (id, next_index) VALUES (0, ?1)
             ON CONFLICT (id) DO UPDATE SET next_index = excluded.next_index",
            [next],
        )?;
        let address = derive(index)?;
        tx.execute(
            "INSERT INTO zec_deposit_address
                 (quote_id, diversifier_index, address, amount_zats, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![quote_id, index, address, amount_zats as i64, expires_at as i64],
        )?;
        let quote = get_quote(&tx, quote_id)?.context("quote vanished after insert")?;
        tx.commit()?;
        Ok(quote)
    }

    pub fn quote(&self, quote_id: &str) -> Result<Option<Quote>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        get_quote(&tx, quote_id)
    }

    /// Credits newly seen notes to their quotes (matched by diversifier index; notes to
    /// unknown indexes are ignored), refreshes `received_zats` and `confirmations` at chain
    /// tip `tip`, and marks quotes PAID once they have enough value and confirmations.
    ///
    /// Returns the quotes that became PAID in this call. Each quote is returned at most once,
    /// ever: `paid_emitted` is set in the same transaction.
    pub fn apply_notes(&self, notes: &[ReceivedNote], tip: u32, min_confirmations: u32) -> Result<Vec<Quote>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        for note in notes {
            let Some(index) = note.diversifier_index else { continue };
            let quote_id: Option<String> = tx
                .query_row(
                    "SELECT quote_id FROM zec_deposit_address WHERE diversifier_index = ?1",
                    [index],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(quote_id) = quote_id else { continue };
            tx.execute(
                "INSERT OR IGNORE INTO zec_credited_note (txid, action_index, quote_id, value, mined_height)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![note.txid, note.action_index, quote_id, note.value as i64, note.mined_height],
            )?;
        }

        // Confirmations of a quote = those of its most recent note (the least confirmed).
        tx.execute(
            "UPDATE zec_deposit_address AS q
             SET received_zats = s.total,
                 confirmations = MAX(0, ?1 - s.last_height + 1)
             FROM (SELECT quote_id, SUM(value) AS total, MAX(mined_height) AS last_height
                   FROM zec_credited_note GROUP BY quote_id) AS s
             WHERE q.quote_id = s.quote_id AND q.paid_emitted = 0",
            [tip],
        )?;

        let newly_paid: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT quote_id FROM zec_deposit_address
                 WHERE paid_emitted = 0 AND received_zats >= amount_zats AND confirmations >= ?1",
            )?;
            stmt.query_map([min_confirmations], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        let mut paid = vec![];
        for quote_id in newly_paid {
            tx.execute("UPDATE zec_deposit_address SET paid_emitted = 1 WHERE quote_id = ?1", [&quote_id])?;
            paid.push(get_quote(&tx, &quote_id)?.context("quote vanished")?);
        }
        tx.commit()?;
        Ok(paid)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawalState {
    Unpaid,
    Built,
    Signing,
    Broadcast,
    Mined,
    Failed,
}

impl WithdrawalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unpaid => "UNPAID",
            Self::Built => "BUILT",
            Self::Signing => "SIGNING",
            Self::Broadcast => "BROADCAST",
            Self::Mined => "MINED",
            Self::Failed => "FAILED",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "UNPAID" => Self::Unpaid,
            "BUILT" => Self::Built,
            "SIGNING" => Self::Signing,
            "BROADCAST" => Self::Broadcast,
            "MINED" => Self::Mined,
            "FAILED" => Self::Failed,
            other => anyhow::bail!("unknown withdrawal state {other}"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal {
    pub quote_id: String,
    pub address: String,
    pub amount_zats: u64,
    pub fee_zats: u64,
    pub state: WithdrawalState,
    pub pczt_blob: Option<Vec<u8>>,
    pub txid: Option<String>,
    /// 0 = never expires.
    pub expiry_height: Option<u32>,
    pub updated_at: u64,
    /// Where the node last had the transaction mined; `None` while unmined.
    pub mined_at: Option<MinedAt>,
    /// Why a person must act on this row; the processor no longer retries it.
    pub operator_action: Option<String>,
}

/// A block a withdrawal's transaction was seen mined in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinedAt {
    pub height: u32,
    /// Hex, display order.
    pub block_hash: String,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Prefix `resolve_operator_action` puts on `operator_action`.
const RESOLVED: &str = "resolved by operator: ";

const WITHDRAWAL_COLUMNS: &str =
    "quote_id, address, amount_zats, fee_zats, state, pczt_blob, txid, expiry_height, updated_at, \
     mined_height, mined_block_hash, operator_action";

fn row_to_withdrawal(r: &rusqlite::Row) -> rusqlite::Result<(Withdrawal, String)> {
    Ok((
        Withdrawal {
            quote_id: r.get(0)?,
            address: r.get(1)?,
            amount_zats: r.get::<_, i64>(2)? as u64,
            fee_zats: r.get::<_, i64>(3)? as u64,
            state: WithdrawalState::Unpaid, // replaced by the parsed column below
            pczt_blob: r.get(5)?,
            txid: r.get(6)?,
            expiry_height: r.get(7)?,
            updated_at: r.get::<_, i64>(8)? as u64,
            mined_at: match (r.get::<_, Option<u32>>(9)?, r.get::<_, Option<String>>(10)?) {
                (Some(height), Some(block_hash)) => Some(MinedAt { height, block_hash }),
                _ => None,
            },
            operator_action: r.get(11)?,
        },
        r.get(4)?,
    ))
}

fn finish_row((mut w, state): (Withdrawal, String)) -> Result<Withdrawal> {
    w.state = WithdrawalState::parse(&state)?;
    Ok(w)
}

impl QuoteStore {
    /// Records a priced withdrawal quote. Re-quoting an id that is still UNPAID updates it;
    /// one that has gone further is left untouched.
    pub fn insert_withdrawal(&self, quote_id: &str, address: &str, amount_zats: u64, fee_zats: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO zec_withdrawal (quote_id, address, amount_zats, fee_zats, state, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'UNPAID', ?5)
             ON CONFLICT (quote_id) DO UPDATE SET
                 address = excluded.address, amount_zats = excluded.amount_zats,
                 fee_zats = excluded.fee_zats, updated_at = excluded.updated_at
             WHERE zec_withdrawal.state = 'UNPAID'",
            params![quote_id, address, amount_zats as i64, fee_zats as i64, now()],
        )?;
        Ok(())
    }

    pub fn withdrawal(&self, quote_id: &str) -> Result<Option<Withdrawal>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {WITHDRAWAL_COLUMNS} FROM zec_withdrawal WHERE quote_id = ?1"),
            [quote_id],
            row_to_withdrawal,
        )
        .optional()?
        .map(finish_row)
        .transpose()
    }

    pub fn withdrawals_in(&self, states: &[WithdrawalState]) -> Result<Vec<Withdrawal>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {WITHDRAWAL_COLUMNS} FROM zec_withdrawal ORDER BY updated_at, quote_id"
        ))?;
        let rows = stmt.query_map([], row_to_withdrawal)?;
        let mut out = vec![];
        for row in rows {
            let w = finish_row(row?)?;
            if states.contains(&w.state) {
                out.push(w);
            }
        }
        Ok(out)
    }

    /// UNPAID -> BUILT, saving the PCZT, the fee actually used and the expiry height.
    /// Returns false (and changes nothing) if the row was not UNPAID.
    pub fn mark_built(&self, quote_id: &str, pczt: &[u8], fee_zats: u64, expiry_height: u32) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE zec_withdrawal SET state = 'BUILT', pczt_blob = ?2, fee_zats = ?3,
                 expiry_height = ?4, updated_at = ?5
             WHERE quote_id = ?1 AND state = 'UNPAID'",
            params![quote_id, pczt, fee_zats as i64, expiry_height, now()],
        )? == 1)
    }

    /// SIGNING -> BROADCAST, saving the txid. Called before the transaction is sent.
    pub fn mark_broadcast(&self, quote_id: &str, txid: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE zec_withdrawal SET state = 'BROADCAST', txid = ?2, updated_at = ?3
             WHERE quote_id = ?1 AND state = 'SIGNING'",
            params![quote_id, txid, now()],
        )? == 1)
    }

    /// Flags a row for a person (see `operator_action`). Returns whether the row exists.
    pub fn set_operator_action(&self, quote_id: &str, reason: Option<&str>) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE zec_withdrawal SET operator_action = ?2, updated_at = ?3 WHERE quote_id = ?1",
            params![quote_id, reason, now()],
        )? == 1)
    }

    /// Rows flagged for a person and not yet resolved.
    pub fn needing_operator_action(&self) -> Result<Vec<Withdrawal>> {
        Ok(self
            .withdrawals_in(&[WithdrawalState::Mined, WithdrawalState::Broadcast, WithdrawalState::Failed])?
            .into_iter()
            .filter(|w| w.operator_action.as_deref().is_some_and(|a| !a.starts_with(RESOLVED)))
            .collect())
    }

    /// Marks a flagged row as dealt with. It stays out of the watcher (never retried) and off
    /// `/reserves`. Returns the original reason, or `None` if the row was not flagged.
    pub fn resolve_operator_action(&self, quote_id: &str) -> Result<Option<String>> {
        let Some(reason) = self.withdrawal(quote_id)?.and_then(|w| w.operator_action) else { return Ok(None) };
        if reason.starts_with(RESOLVED) {
            return Ok(None);
        }
        self.set_operator_action(quote_id, Some(&format!("{RESOLVED}{reason}")))?;
        Ok(Some(reason))
    }

    /// Records (or with `None`, clears) the block the withdrawal's transaction is mined in.
    pub fn set_mined_at(&self, quote_id: &str, at: Option<&MinedAt>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE zec_withdrawal SET mined_height = ?2, mined_block_hash = ?3 WHERE quote_id = ?1",
            params![quote_id, at.map(|m| m.height), at.map(|m| m.block_hash.as_str())],
        )?;
        Ok(())
    }

    /// Moves `quote_id` to `to` only if it is currently in one of `from`. Returns whether it moved,
    /// so a transition (and the event that goes with it) happens at most once.
    pub fn transition(&self, quote_id: &str, from: &[WithdrawalState], to: WithdrawalState) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let from: Vec<&str> = from.iter().map(|s| s.as_str()).collect();
        let placeholders = (0..from.len()).map(|i| format!("?{}", i + 4)).collect::<Vec<_>>().join(", ");
        let to = to.as_str();
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&quote_id, &to];
        let ts = now();
        args.push(&ts);
        for f in &from {
            args.push(f);
        }
        Ok(conn.execute(
            &format!(
                "UPDATE zec_withdrawal SET state = ?2, updated_at = ?3
                 WHERE quote_id = ?1 AND state IN ({placeholders})"
            ),
            args.as_slice(),
        )? == 1)
    }
}

fn get_quote(tx: &Transaction, quote_id: &str) -> Result<Option<Quote>> {
    Ok(tx
        .query_row(
            "SELECT quote_id, diversifier_index, address, amount_zats, received_zats,
                    confirmations, paid_emitted, expires_at
             FROM zec_deposit_address WHERE quote_id = ?1",
            [quote_id],
            |r| {
                Ok(Quote {
                    quote_id: r.get(0)?,
                    diversifier_index: r.get(1)?,
                    address: r.get(2)?,
                    amount_zats: r.get::<_, i64>(3)? as u64,
                    received_zats: r.get::<_, i64>(4)? as u64,
                    confirmations: r.get(5)?,
                    paid_emitted: r.get(6)?,
                    expires_at: r.get::<_, i64>(7)? as u64,
                })
            },
        )
        .optional()?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh on-disk DB path (on disk, so tests can "restart" by reopening it). Unique per
    /// call: tests run in parallel and the clock alone can repeat (microsecond resolution).
    pub(crate) fn temp_db(name: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "zec-processor-test-{name}-{}-{n}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn addr(i: u32) -> Result<String> {
        Ok(format!("uregtest1-test-{i}"))
    }

    fn note(txid: &str, index: Option<u32>, value: u64, height: u32) -> ReceivedNote {
        ReceivedNote {
            txid: txid.to_owned(),
            action_index: 0,
            value,
            diversifier_index: index,
            mined_height: height,
        }
    }

    #[test]
    fn diversifier_indexes_increase_and_survive_restart() {
        let path = temp_db("indexes");
        let store = QuoteStore::open(&path).unwrap();
        let a = store.create_quote("qa", 1000, 0, addr).unwrap();
        let b = store.create_quote("qb", 1000, 0, addr).unwrap();
        // A failed derivation stores nothing (its index was never handed out, so it may be retried).
        assert!(store.create_quote("qfail", 1000, 0, |_| anyhow::bail!("boom")).is_err());
        assert!(store.quote("qfail").unwrap().is_none());
        // Re-creating an existing quote returns it, without reserving a new index.
        assert_eq!(store.create_quote("qa", 1000, 0, addr).unwrap(), a);
        drop(store);

        let store = QuoteStore::open(&path).unwrap();
        let c = store.create_quote("qc", 1000, 0, addr).unwrap();
        assert_eq!(a.diversifier_index, FIRST_DEPOSIT_INDEX);
        assert!(a.diversifier_index < b.diversifier_index);
        assert!(b.diversifier_index < c.diversifier_index);
        assert_eq!(c.address, format!("uregtest1-test-{}", c.diversifier_index));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unknown_diversifier_ignored_and_partials_add_up() {
        let store = QuoteStore::open(&temp_db("partials")).unwrap();
        let q = store.create_quote("q", 50_000, 0, addr).unwrap();
        let i = Some(q.diversifier_index);

        let paid = store
            .apply_notes(&[note("t0", Some(999), 50_000, 10), note("t0b", None, 50_000, 10)], 10, 1)
            .unwrap();
        assert!(paid.is_empty(), "notes to unknown/no index must not pay anything");
        assert_eq!(store.quote("q").unwrap().unwrap().received_zats, 0);

        let paid = store.apply_notes(&[note("t1", i, 20_000, 11)], 11, 1).unwrap();
        assert!(paid.is_empty(), "a partial payment is not PAID");
        assert_eq!(store.quote("q").unwrap().unwrap().received_zats, 20_000);

        let paid = store
            .apply_notes(&[note("t1", i, 20_000, 11), note("t2", i, 30_000, 12)], 12, 1)
            .unwrap();
        assert_eq!(paid.len(), 1);
        assert_eq!(paid[0].received_zats, 50_000, "t1 must not be counted twice");
        assert!(paid[0].paid_emitted);
    }

    #[test]
    fn old_withdrawal_table_gains_mined_columns() {
        let path = temp_db("migrate");
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE zec_withdrawal (quote_id TEXT PRIMARY KEY, address TEXT NOT NULL,
                     amount_zats INTEGER NOT NULL, fee_zats INTEGER NOT NULL, state TEXT NOT NULL,
                     pczt_blob BLOB, txid TEXT, expiry_height INTEGER, updated_at INTEGER NOT NULL);
                 INSERT INTO zec_withdrawal VALUES ('old', 'a', 1, 1, 'MINED', NULL, 'tx', 0, 0);",
            )
            .unwrap();
        let store = QuoteStore::open(&path).unwrap();
        assert_eq!(store.withdrawal("old").unwrap().unwrap().mined_at, None);
        let at = MinedAt { height: 7, block_hash: "ab".into() };
        store.set_mined_at("old", Some(&at)).unwrap();
        drop(store);
        let store = QuoteStore::open(&path).unwrap();
        assert_eq!(store.withdrawal("old").unwrap().unwrap().mined_at, Some(at), "reopen does not migrate twice");
    }

    #[test]
    fn waits_for_confirmations() {
        let store = QuoteStore::open(&temp_db("confs")).unwrap();
        let q = store.create_quote("q", 50_000, 0, addr).unwrap();
        let notes = [note("t1", Some(q.diversifier_index), 50_000, 20)];
        assert!(store.apply_notes(&notes, 20, 3).unwrap().is_empty()); // 1 confirmation
        assert!(store.apply_notes(&notes, 21, 3).unwrap().is_empty()); // 2
        assert_eq!(store.apply_notes(&notes, 22, 3).unwrap().len(), 1); // 3
        assert_eq!(store.quote("q").unwrap().unwrap().confirmations, 3);
    }

    #[test]
    fn exactly_one_event_across_repeated_syncs() {
        let store = QuoteStore::open(&temp_db("once")).unwrap();
        let q = store.create_quote("q", 50_000, 0, addr).unwrap();
        let notes = [note("t1", Some(q.diversifier_index), 50_000, 5)];
        let mut events = 0;
        for tip in 5..15 {
            events += store.apply_notes(&notes, tip, 1).unwrap().len();
        }
        // An extra overpayment after PAID doesn't fire again either.
        let more = [notes[0].clone(), note("t2", Some(q.diversifier_index), 1, 15)];
        events += store.apply_notes(&more, 15, 1).unwrap().len();
        assert_eq!(events, 1);
    }

    #[test]
    fn restart_rereads_state_and_paid_quote_does_not_refire() {
        let path = temp_db("restart");
        let store = QuoteStore::open(&path).unwrap();
        let paid_q = store.create_quote("paid", 50_000, 0, addr).unwrap();
        let open_q = store.create_quote("open", 50_000, 0, addr).unwrap();
        let notes = vec![
            note("t1", Some(paid_q.diversifier_index), 50_000, 5),
            note("t2", Some(open_q.diversifier_index), 10_000, 5),
        ];
        assert_eq!(store.apply_notes(&notes, 5, 1).unwrap().len(), 1);
        drop(store);

        let store = QuoteStore::open(&path).unwrap();
        let reread = store.quote("paid").unwrap().unwrap();
        assert!(reread.paid_emitted);
        assert_eq!(reread.received_zats, 50_000);
        assert_eq!(store.quote("open").unwrap().unwrap().received_zats, 10_000);
        // The same notes come back from a fresh wallet scan: nothing fires.
        assert!(store.apply_notes(&notes, 6, 1).unwrap().is_empty());
        // The open quote completes normally after the restart.
        let mut notes = notes;
        notes.push(note("t3", Some(open_q.diversifier_index), 40_000, 7));
        let paid = store.apply_notes(&notes, 7, 1).unwrap();
        assert_eq!(paid.len(), 1);
        assert_eq!(paid[0].quote_id, "open");
        let _ = std::fs::remove_file(path);
    }
}
