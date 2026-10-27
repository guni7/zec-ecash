//! Reserve invariant: the confirmed shielded reserve must cover all outstanding ecash plus the
//! withdrawals in flight. Checked after every sync; while it fails, the processor refuses new
//! mint quotes and `/reserves` says why.
//!
//! The three figures are chosen so a withdrawal never trips the check at any stage:
//! - reserve (zec_wallet::Wallet::confirmed_reserve): notes at depth, plus the mint's own change
//!   from mined withdrawals; a note spent by a still-unmined withdrawal counts as reserve.
//! - outstanding: issued - redeemed - melt inputs still PENDING, from cdk-mintd's DB.
//! - in flight: amount + fee of withdrawals whose transaction is not mined yet.
//!
//! So while a withdrawal is unmined its ecash leaves "outstanding" and its payment joins "in
//! flight" (both sides move by about the same amount; the fee reserve is at least the fee). Once
//! mined, the payment leaves the reserve and "in flight" together.
use std::{path::Path, sync::Arc};

use anyhow::{Context, Result};
use axum::{Json, http::StatusCode};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tokio::sync::RwLock;

use crate::store::{QuoteStore, WithdrawalState};

/// cdk-mintd's accounting for one unit, from its `keyset_amounts` and `proof` tables.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MintLedger {
    pub issued: u64,
    pub redeemed: u64,
    /// Inputs of melts that have not settled yet (proof state PENDING).
    pub pending_melt: u64,
}

impl MintLedger {
    pub fn outstanding(&self) -> u64 {
        self.issued.saturating_sub(self.redeemed).saturating_sub(self.pending_melt)
    }
}

/// Reads the ledger for `unit` from cdk-mintd's SQLite DB, read-only.
pub fn read_mint_ledger(path: &Path, unit: &str) -> Result<MintLedger> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_context(|| format!("cannot open the mint DB {} read-only", path.display()))?;
    let (issued, redeemed): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(a.total_issued), 0), COALESCE(SUM(a.total_redeemed), 0)
         FROM keyset_amounts a JOIN keyset k ON k.id = a.keyset_id WHERE k.unit = ?1",
        [unit],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let pending_melt: i64 = conn.query_row(
        "SELECT COALESCE(SUM(p.amount), 0) FROM proof p JOIN keyset k ON k.id = p.keyset_id
         WHERE k.unit = ?1 AND p.state = 'PENDING' AND p.operation_kind = 'melt'",
        [unit],
        |r| r.get(0),
    )?;
    let n = |v: i64| u64::try_from(v).context("negative amount in the mint DB");
    Ok(MintLedger { issued: n(issued)?, redeemed: n(redeemed)?, pending_melt: n(pending_melt)? })
}

/// Why a deposit quote is refused. The mint shows every refusal as "Invalid payment request",
/// so this is also served at `/deposit-quote` for wallets to ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepositRefusal {
    AmountOutOfRange { amount: u64, min: u64, max: u64 },
    /// The reserve invariant fails (see [`ReserveStatus`]).
    ReserveViolated { reserve: u64, required: u64 },
    /// reserve + open quotes + this amount would pass ZEC_MAX_RESERVE.
    ReserveCap { cap: u64, reserve: u64, open_quotes: u64, amount: u64 },
    /// The check itself could not run.
    CheckFailed(String),
}

impl DepositRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AmountOutOfRange { .. } => "amount_out_of_range",
            Self::ReserveViolated { .. } => "reserve_violated",
            Self::ReserveCap { .. } => "reserve_cap",
            Self::CheckFailed(_) => "check_failed",
        }
    }
}

impl std::fmt::Display for DepositRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AmountOutOfRange { amount, min, max } => {
                write!(f, "amount {amount} zat is outside the mint's deposit limits ({min}..={max} zat)")
            }
            Self::ReserveViolated { reserve, required } => write!(
                f,
                "deposits are paused: the confirmed reserve ({reserve} zat) is below outstanding ecash plus \
                 withdrawals in flight ({required} zat); see /reserves"
            ),
            Self::ReserveCap { cap, reserve, open_quotes, amount } => write!(
                f,
                "reserve cap reached: the reserve holds {reserve} zat and open deposit quotes could add \
                 {open_quotes} zat, so {amount} zat more would pass the mint's cap of {cap} zat \
                 (ZEC_MAX_RESERVE); at most {} zat can be deposited now",
                cap.saturating_sub(reserve.saturating_add(*open_quotes))
            ),
            Self::CheckFailed(e) => write!(f, "the deposit check could not run: {e}"),
        }
    }
}

impl std::error::Error for DepositRefusal {}

/// The cap rule: refuse when `reserve` (everything the wallet holds on chain) plus what open
/// quotes could still bring in plus `amount` would exceed `cap`.
pub fn check_cap(cap: u64, reserve: u64, open_quotes: u64, amount: u64) -> Result<(), DepositRefusal> {
    if reserve.saturating_add(open_quotes).saturating_add(amount) > cap {
        return Err(DepositRefusal::ReserveCap { cap, reserve, open_quotes, amount });
    }
    Ok(())
}

/// Amount + fee of every withdrawal that has a built transaction not yet mined.
pub fn in_flight(store: &QuoteStore) -> Result<u64> {
    use WithdrawalState::*;
    Ok(store
        .withdrawals_in(&[Built, Signing, Broadcast])?
        .iter()
        .filter(|w| w.mined_at.is_none())
        .map(|w| w.amount_zats + w.fee_zats)
        .sum())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReserveStatus {
    /// `true` when reserve >= required.
    pub ok: bool,
    pub reserve_zats: u64,
    /// outstanding + in flight.
    pub required_zats: u64,
    pub outstanding_zats: u64,
    pub in_flight_zats: u64,
    /// required - reserve when violated, else 0.
    pub shortfall_zats: u64,
    pub ledger: MintLedger,
    /// Height the reserve wallet had scanned to.
    pub chain_height: u32,
    pub min_confirmations: u32,
    /// Unix seconds.
    pub checked_at: u64,
    /// Withdrawals the processor gave up on; a person must act (see `zec-processor resolve`).
    /// Public, so no address, txid or reason: those are in the processor log (CRITICAL) and in
    /// `zec-processor operator-actions` on the mint host.
    pub operator_action: Vec<OperatorAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OperatorAction {
    pub quote_id: String,
    pub amount_zats: u64,
    /// Unix seconds the row was flagged.
    pub flagged_at: u64,
}

/// Rows flagged in the store, for [`ReserveStatus::operator_action`].
pub fn operator_actions(store: &QuoteStore) -> Result<Vec<OperatorAction>> {
    Ok(store
        .needing_operator_action()?
        .into_iter()
        .map(|w| OperatorAction { quote_id: w.quote_id, amount_zats: w.amount_zats, flagged_at: w.updated_at })
        .collect())
}

pub fn evaluate(
    reserve_zats: u64,
    ledger: MintLedger,
    in_flight_zats: u64,
    chain_height: u32,
    min_confirmations: u32,
    checked_at: u64,
) -> ReserveStatus {
    let outstanding_zats = ledger.outstanding();
    let required_zats = outstanding_zats + in_flight_zats;
    ReserveStatus {
        ok: reserve_zats >= required_zats,
        reserve_zats,
        required_zats,
        outstanding_zats,
        in_flight_zats,
        shortfall_zats: required_zats.saturating_sub(reserve_zats),
        ledger,
        chain_height,
        min_confirmations,
        checked_at,
        operator_action: vec![],
    }
}

/// Latest check, shared by the sync loop (writer), the quote path and `/reserves` (readers).
#[derive(Clone, Default)]
pub struct ReserveMonitor {
    inner: Arc<RwLock<Monitor>>,
}

/// Whether one guardian answered its last `/status` probe (public in `/reserves`: no URL, no
/// error text, so nothing about where the guardians are).
#[derive(Clone, Debug, Serialize)]
pub struct GuardianHealth {
    /// The guardian's position in ZEC_GUARDIANS (= its FROST id).
    pub id: usize,
    pub up: bool,
    /// It answered as the right guardian id with the group key the reserve uses.
    pub key_ok: bool,
    /// Unix seconds of the last answer, if it ever answered.
    pub last_seen: Option<u64>,
}

#[derive(Default)]
struct Monitor {
    last: Option<ReserveStatus>,
    /// Why the last check could not run, if it couldn't.
    error: Option<String>,
    /// When a violation was last logged (unix seconds), to repeat it once a minute, not every pass.
    last_alarm: u64,
    guardians: Vec<GuardianHealth>,
    guardians_checked_at: Option<u64>,
}

/// How often a continuing violation is logged again.
const ALARM_REPEAT_SECS: u64 = 60;

impl ReserveMonitor {
    pub async fn record(&self, status: ReserveStatus) {
        let mut m = self.inner.write().await;
        let was_ok = m.last.as_ref().is_none_or(|s| s.ok);
        if !status.ok {
            if was_ok || status.checked_at >= m.last_alarm + ALARM_REPEAT_SECS {
                tracing::error!(
                    reserve_zats = status.reserve_zats,
                    required_zats = status.required_zats,
                    outstanding_zats = status.outstanding_zats,
                    in_flight_zats = status.in_flight_zats,
                    shortfall_zats = status.shortfall_zats,
                    "RESERVE INVARIANT VIOLATED: confirmed reserve is below outstanding ecash + withdrawals \
                     in flight; refusing new mint quotes until it is restored"
                );
                m.last_alarm = status.checked_at;
            }
        } else if !was_ok {
            tracing::warn!(
                reserve_zats = status.reserve_zats,
                required_zats = status.required_zats,
                "reserve invariant restored; accepting mint quotes again"
            );
        }
        m.last = Some(status);
        m.error = None;
    }

    pub async fn record_error(&self, error: String) {
        let mut m = self.inner.write().await;
        if m.error.as_deref() != Some(error.as_str()) {
            tracing::error!("reserve check could not run: {error}");
        }
        m.error = Some(error);
    }

    /// Stores the latest guardian probe (keeps each guardian's last_seen across failed probes).
    pub async fn record_guardians(&self, mut probe: Vec<GuardianHealth>, checked_at: u64) {
        let mut m = self.inner.write().await;
        for g in &mut probe {
            if g.last_seen.is_none() {
                g.last_seen = m.guardians.iter().find(|o| o.id == g.id).and_then(|o| o.last_seen);
            }
        }
        m.guardians = probe;
        m.guardians_checked_at = Some(checked_at);
    }

    /// `Some(status)` if the last completed check failed. A check that could not run does not
    /// block quotes (the last completed result still applies).
    pub async fn violation(&self) -> Option<ReserveStatus> {
        self.inner.read().await.last.clone().filter(|s| !s.ok)
    }
}

#[derive(Serialize)]
struct Body {
    /// "violated", "operator_action_required" (invariant holds, but a withdrawal needs a
    /// person), "ok", or "unknown" (no completed check yet).
    state: &'static str,
    #[serde(flatten)]
    status: Option<ReserveStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    guardians: Vec<GuardianHealth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    guardians_checked_at: Option<u64>,
}

impl ReserveMonitor {
    /// The `/reserves` response: 200 when ok, 503 otherwise.
    pub async fn report(&self) -> (StatusCode, Json<serde_json::Value>) {
        let m = self.inner.read().await;
        let state = match &m.last {
            Some(s) if !s.ok => "violated",
            Some(s) if !s.operator_action.is_empty() => "operator_action_required",
            Some(_) => "ok",
            None => "unknown",
        };
        let code = if state == "ok" { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
        let body = Body {
            state,
            status: m.last.clone(),
            error: m.error.clone(),
            guardians: m.guardians.clone(),
            guardians_checked_at: m.guardians_checked_at,
        };
        (code, Json(serde_json::to_value(body).unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_report_has_no_withdrawal_details() {
        let monitor = ReserveMonitor::default();
        let mut status = evaluate(100, MintLedger::default(), 0, 10, 1, 1_000);
        status.operator_action = vec![OperatorAction { quote_id: "q1".into(), amount_zats: 5_000, flagged_at: 999 }];
        monitor.record(status).await;
        let (_, axum::Json(v)) = monitor.report().await;
        assert_eq!(v["state"], "operator_action_required");
        let a = &v["operator_action"][0];
        assert_eq!((a["quote_id"].as_str(), a["amount_zats"].as_u64(), a["flagged_at"].as_u64()), (Some("q1"), Some(5_000), Some(999)));
        let text = v.to_string();
        assert!(!text.contains("address") && !text.contains("txid") && !text.contains("reason"), "{text}");
    }
    use crate::{
        store::MinedAt,
        withdraw::{BuiltTx, Reserve, make_payment},
    };
    use async_trait::async_trait;

    fn ledger(issued: u64, redeemed: u64, pending_melt: u64) -> MintLedger {
        MintLedger { issued, redeemed, pending_melt }
    }

    #[test]
    fn cap_counts_reserve_open_quotes_and_the_new_amount() {
        assert!(check_cap(1_000_000, 900_000, 50_000, 50_000).is_ok(), "exactly at the cap is fine");
        let e = check_cap(1_000_000, 900_000, 50_000, 50_001).unwrap_err();
        assert_eq!(e, DepositRefusal::ReserveCap { cap: 1_000_000, reserve: 900_000, open_quotes: 50_000, amount: 50_001 });
        assert!(e.to_string().contains("at most 50000 zat can be deposited now"), "{e}");
        assert!(check_cap(1_000_000, 1_200_000, 0, 1).is_err(), "already over: nothing more");
        let e = check_cap(u64::MAX - 1, u64::MAX, 1, 1).unwrap_err();
        assert!(e.to_string().contains("at most 0 zat"), "no overflow: {e}");
    }

    #[test]
    fn holds_when_reserve_covers_outstanding_plus_in_flight() {
        let s = evaluate(289_000, ledger(730_386, 441_386, 0), 0, 130, 1, 0);
        assert!(s.ok);
        assert_eq!((s.outstanding_zats, s.required_zats, s.shortfall_zats), (289_000, 289_000, 0));
    }

    #[test]
    fn violated_reports_the_shortfall() {
        let s = evaluate(216_000, ledger(730_386, 441_386, 0), 0, 130, 1000, 0);
        assert!(!s.ok);
        assert_eq!(s.shortfall_zats, 73_000);
    }

    /// Walk one withdrawal (12_000 zat of ecash: 2_000 amount + 10_000 fee reserve; the
    /// transaction pays 2_000 + a 10_000 fee from a 50_000 note, 38_000 change) through every
    /// stage: the invariant must hold at each one, with zero surplus.
    #[test]
    fn a_withdrawal_never_trips_the_check() {
        let (r, issued, redeemed) = (100_000u64, 150_000u64, 50_000u64); // 100_000 outstanding
        // Melt PENDING, tx built or broadcast but unmined: inputs still on chain.
        let s = evaluate(r, ledger(issued, redeemed, 12_000), 12_000, 0, 3, 0);
        assert!(s.ok && s.reserve_zats == s.required_zats, "{s:?}");
        // Mined, below depth: the 50_000 note is spent, its 38_000 change counts; no longer in flight.
        let s = evaluate(r - 50_000 + 38_000, ledger(issued, redeemed, 12_000), 0, 0, 3, 0);
        assert!(s.ok && s.reserve_zats == s.required_zats, "{s:?}");
        // PAID: the inputs are redeemed (no fee left over, so no change ecash).
        let s = evaluate(r - 12_000, ledger(issued, redeemed + 12_000, 0), 0, 0, 3, 0);
        assert!(s.ok && s.reserve_zats == s.required_zats, "{s:?}");
    }

    struct OneTx;
    #[async_trait]
    impl Reserve for OneTx {
        fn quote_fee(&mut self, _: &str, _: u64) -> Result<u64> {
            Ok(10_000)
        }
        fn build(&mut self, _: &str, _: u64) -> Result<BuiltTx> {
            Ok(BuiltTx { pczt: vec![1], fee: 10_000, expiry_height: 0 })
        }
        async fn sign(&mut self, p: Vec<u8>, _: &str) -> Result<Vec<u8>> {
            Ok(p)
        }
        fn finalize(&mut self, _: Vec<u8>) -> Result<String> {
            Ok("tx1".into())
        }
        async fn broadcast(&mut self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn in_flight_counts_unmined_withdrawals_only() {
        let store = QuoteStore::open(&crate::store::tests::temp_db("reserves")).unwrap();
        store.insert_withdrawal("q", "uregtest1dest", 2_000, 10_000).unwrap();
        store.insert_withdrawal("unpaid", "uregtest1dest", 5_000, 10_000).unwrap();
        assert_eq!(in_flight(&store).unwrap(), 0, "an UNPAID quote has built nothing");
        make_payment(&store, &mut OneTx, "q", None).await.unwrap();
        assert_eq!(in_flight(&store).unwrap(), 12_000);
        store.set_mined_at("q", Some(&MinedAt { height: 5, block_hash: "aa".into() })).unwrap();
        assert_eq!(in_flight(&store).unwrap(), 0, "mined: the payment has left the reserve");
    }

    #[tokio::test]
    async fn monitor_blocks_only_on_a_completed_failed_check() {
        let m = ReserveMonitor::default();
        assert!(m.violation().await.is_none(), "unknown does not block");
        m.record(evaluate(1, ledger(10, 0, 0), 0, 1, 1, 100)).await;
        assert!(m.violation().await.is_some());
        m.record_error("mint DB locked".into()).await;
        assert!(m.violation().await.is_some(), "a failed check keeps the last result");
        m.record(evaluate(10, ledger(10, 0, 0), 0, 1, 1, 200)).await;
        assert!(m.violation().await.is_none(), "restored");
    }
}
