//! Withdrawal (melt) pipeline and settlement, independent of the wallet so it can be tested.
//!
//! The rule everything here serves (CDK's MintPayment contract): the mint treats Failed/Unpaid
//! as final and refunds the user's ecash. So from the moment a PCZT is built until the
//! transaction is mined, a withdrawal reports Pending. It reports Failed only when nothing was
//! ever broadcast, or when the chain is past the transaction's expiry height and it isn't mined.
//! The txid is saved (state BROADCAST) *before* the transaction is sent.
//!
//! Reorgs: the watcher records the block a transaction is mined in. If the node later no longer
//! has it mined (that block was replaced), the record is cleared and the withdrawal keeps
//! reporting Pending while it is rebroadcast. It settles PAID only once the block it is in now
//! is `min_confirmations` deep.
use std::collections::HashMap;

use anyhow::{Result, bail};
use async_trait::async_trait;
use cdk_common::nuts::MeltQuoteState;

use crate::store::{MinedAt, QuoteStore, Withdrawal, WithdrawalState};

use WithdrawalState::*;

/// What the pipeline needs from the reserve wallet. PCZTs travel as serialized bytes.
#[async_trait]
pub trait Reserve: Send {
    /// The fee a payment would cost now. Builds nothing.
    fn quote_fee(&mut self, to: &str, zats: u64) -> Result<u64>;
    /// Proposes and creates the unsigned PCZT.
    fn build(&mut self, to: &str, zats: u64) -> Result<BuiltTx>;
    async fn sign(&mut self, pczt: Vec<u8>, quote_id: &str) -> Result<Vec<u8>>;
    /// Proves, extracts, verifies and stores the transaction; returns its txid. Does not send.
    fn finalize(&mut self, signed: Vec<u8>) -> Result<String>;
    /// Sends a finalized transaction to the node; safe to repeat.
    async fn broadcast(&mut self, txid: &str) -> Result<()>;
}

pub struct BuiltTx {
    pub pczt: Vec<u8>,
    pub fee: u64,
    /// 0 = never expires.
    pub expiry_height: u32,
}

/// What `check_outgoing_payment` and `make_payment` report for a withdrawal.
pub fn status_of(w: &Withdrawal) -> MeltQuoteState {
    match w.state {
        Unpaid => MeltQuoteState::Unpaid,
        // Something may reach (or has reached) the chain: never final.
        Built | Signing | Broadcast => MeltQuoteState::Pending,
        Mined => MeltQuoteState::Paid,
        Failed => MeltQuoteState::Failed,
    }
}

/// Runs a withdrawal to the end in one call: [`begin`] then [`complete`]. Idempotent: if the
/// quote is already past UNPAID it returns the current row without building anything again.
#[cfg(test)]
pub async fn make_payment(
    store: &QuoteStore,
    reserve: &mut dyn Reserve,
    quote_id: &str,
    max_fee: Option<u64>,
) -> Result<Withdrawal> {
    match begin(store, reserve, quote_id, max_fee)? {
        Begun::Built(_) => complete(store, reserve, quote_id).await,
        Begun::Existing(w) => Ok(w),
    }
}

pub enum Begun {
    /// This call built the PCZT (now BUILT); the caller must run [`complete`].
    Built(Withdrawal),
    /// Already past UNPAID: nothing was built, nothing more to do here.
    Existing(Withdrawal),
}

/// First half, run inside `make_payment`: price again, reject a fee above `max_fee`, then build
/// the PCZT and save it (UNPAID -> BUILT). From here on the withdrawal reports Pending.
pub fn begin(store: &QuoteStore, reserve: &mut dyn Reserve, quote_id: &str, max_fee: Option<u64>) -> Result<Begun> {
    let Some(w) = store.withdrawal(quote_id)? else {
        bail!("unknown withdrawal quote {quote_id}");
    };
    if w.state != Unpaid {
        return Ok(Begun::Existing(w));
    }

    // Price it again before building anything; the reserve's notes may have changed.
    let fee = reserve.quote_fee(&w.address, w.amount_zats)?;
    check_fee(fee, max_fee)?;

    let built = reserve.build(&w.address, w.amount_zats)?;
    check_fee(built.fee, max_fee)?;
    if !store.mark_built(quote_id, &built.pczt, built.fee, built.expiry_height)? {
        // Someone else moved it on; report whatever it is now.
        let w = store.withdrawal(quote_id)?.ok_or_else(|| anyhow::anyhow!("quote vanished"))?;
        return Ok(Begun::Existing(w));
    }
    Ok(Begun::Built(store.withdrawal(quote_id)?.ok_or_else(|| anyhow::anyhow!("quote vanished"))?))
}

/// Second half: sign (FROST guardians), prove, extract, save the txid (BROADCAST), send.
/// Any failure before the txid is saved means nothing was sent: the row becomes FAILED and the
/// error is returned (the caller tells the mint, which refunds).
pub async fn complete(store: &QuoteStore, reserve: &mut dyn Reserve, quote_id: &str) -> Result<Withdrawal> {
    let w = store.withdrawal(quote_id)?.ok_or_else(|| anyhow::anyhow!("unknown withdrawal quote {quote_id}"))?;
    if w.state != Built {
        return Ok(w);
    }
    let pczt = w.pczt_blob.clone().ok_or_else(|| anyhow::anyhow!("BUILT withdrawal has no PCZT"))?;
    store.transition(quote_id, &[Built], Signing)?;

    // Until the txid is saved, nothing can have been sent, so a failure here is final.
    let txid = match sign_and_finalize(reserve, pczt, quote_id).await {
        Ok(txid) => txid,
        Err(e) => {
            store.transition(quote_id, &[Built, Signing], Failed)?;
            return Err(e.context("withdrawal failed before broadcast"));
        }
    };
    store.mark_broadcast(quote_id, &txid)?;

    // From here on the transaction may reach the chain. A send error leaves it BROADCAST
    // (Pending); the sync loop rebroadcasts until it is mined or expires.
    if let Err(e) = reserve.broadcast(&txid).await {
        tracing::warn!(%quote_id, %txid, "broadcast failed, will retry: {e:#}");
    }
    store.withdrawal(quote_id)?.ok_or_else(|| anyhow::anyhow!("quote vanished"))
}

async fn sign_and_finalize(reserve: &mut dyn Reserve, pczt: Vec<u8>, quote_id: &str) -> Result<String> {
    let signed = reserve.sign(pczt, quote_id).await?;
    reserve.finalize(signed)
}

fn check_fee(fee: u64, max_fee: Option<u64>) -> Result<()> {
    if let Some(max) = max_fee
        && fee > max
    {
        bail!("withdrawal fee {fee} zat exceeds the quote's fee reserve {max} zat");
    }
    Ok(())
}

/// Startup: BUILT/SIGNING rows never got a txid saved, so nothing reached the chain. They
/// become FAILED (the mint refunds). Returns them. BROADCAST rows are left for the watcher.
pub fn reconcile_unbroadcast(store: &QuoteStore) -> Result<Vec<Withdrawal>> {
    let mut failed = vec![];
    for w in store.withdrawals_in(&[Built, Signing])? {
        if w.txid.is_none() && store.transition(&w.quote_id, &[Built, Signing], Failed)? {
            failed.push(store.withdrawal(&w.quote_id)?.unwrap_or(w));
        }
    }
    Ok(failed)
}

/// How far back a block can still be replaced: Zebra never reorgs more than 99 blocks.
/// Settled (MINED) withdrawals are watched this long.
pub const REORG_WATCH_DEPTH: u32 = 100;

pub enum Settled {
    Paid(Withdrawal),
    Expired(Withdrawal),
    /// The block it was mined in was replaced and the node no longer has it mined. Still
    /// BROADCAST (Pending): rebroadcast it.
    Reorged { w: Withdrawal, was: MinedAt },
    /// Already reported PAID, but its block was replaced and it is no longer mined. The mint
    /// can't take PAID back; rebroadcast it so it is mined again.
    ReorgedAfterPaid { w: Withdrawal, was: MinedAt },
}

/// Txids the watcher must look up on the node at `tip`: every BROADCAST row, and MINED rows
/// whose block could still be reorged away.
pub fn txids_to_watch(store: &QuoteStore, tip: u32) -> Result<Vec<String>> {
    Ok(store
        .withdrawals_in(&[Broadcast, Mined])?
        .into_iter()
        .filter(|w| w.state == Broadcast || w.mined_at.as_ref().is_some_and(|m| tip.saturating_sub(m.height) < REORG_WATCH_DEPTH))
        .filter_map(|w| w.txid)
        .collect())
}

/// Watcher pass at node tip `tip`. `on_chain` is the node's current answer for each txid from
/// [`txids_to_watch`]: the block it is mined in, or `None` (mempool, side chain or unknown).
/// Rows whose txid is not in `on_chain` are skipped. Paid/Expired happen at most once per row.
pub fn settle(
    store: &QuoteStore,
    tip: u32,
    min_confirmations: u32,
    on_chain: &HashMap<String, Option<MinedAt>>,
) -> Result<Vec<Settled>> {
    let mut settled = vec![];
    for w in store.withdrawals_in(&[Broadcast, Mined])? {
        let Some(now) = w.txid.as_deref().and_then(|t| on_chain.get(t)) else { continue };
        if w.state == Mined {
            match (&w.mined_at, now) {
                (Some(was), None) => {
                    let was = was.clone();
                    settled.push(Settled::ReorgedAfterPaid { w, was });
                }
                (was, Some(m)) if was.as_ref() != Some(m) => store.set_mined_at(&w.quote_id, Some(m))?,
                _ => {}
            }
            continue;
        }

        if now != &w.mined_at {
            store.set_mined_at(&w.quote_id, now.as_ref())?;
            match (&w.mined_at, now) {
                (Some(was), None) => {
                    settled.push(Settled::Reorged { w: store.withdrawal(&w.quote_id)?.unwrap_or(w.clone()), was: was.clone() })
                }
                (Some(was), Some(m)) => tracing::warn!(
                    quote_id = %w.quote_id, txid = ?w.txid, was_height = was.height, was_block = %was.block_hash,
                    height = m.height, block = %m.block_hash, "withdrawal now mined in a different block (reorg)"
                ),
                (None, Some(m)) => tracing::info!(
                    quote_id = %w.quote_id, txid = ?w.txid, height = m.height, block = %m.block_hash,
                    "withdrawal seen mined; settles at {min_confirmations} confirmations"
                ),
                (None, None) => {}
            }
        }
        match now {
            Some(m) => {
                let confirmations = tip.saturating_sub(m.height) + 1;
                if m.height <= tip
                    && confirmations >= min_confirmations
                    && store.transition(&w.quote_id, &[Broadcast], Mined)?
                {
                    settled.push(Settled::Paid(store.withdrawal(&w.quote_id)?.unwrap_or(w)));
                }
            }
            None => {
                let expiry = w.expiry_height.unwrap_or(0);
                if expiry != 0 && tip > expiry && store.transition(&w.quote_id, &[Broadcast], Failed)? {
                    settled.push(Settled::Expired(store.withdrawal(&w.quote_id)?.unwrap_or(w)));
                }
            }
        }
    }
    Ok(settled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeReserve {
        fee: u64,
        expiry: u32,
        fail_sign: bool,
        builds: usize,
        finalized: usize,
        broadcasts: usize,
    }

    #[async_trait]
    impl Reserve for FakeReserve {
        fn quote_fee(&mut self, _to: &str, _zats: u64) -> Result<u64> {
            Ok(self.fee)
        }
        fn build(&mut self, _to: &str, _zats: u64) -> Result<BuiltTx> {
            self.builds += 1;
            Ok(BuiltTx { pczt: vec![1, 2, 3], fee: self.fee, expiry_height: self.expiry })
        }
        async fn sign(&mut self, pczt: Vec<u8>, _quote_id: &str) -> Result<Vec<u8>> {
            if self.fail_sign {
                bail!("signer offline");
            }
            Ok(pczt)
        }
        fn finalize(&mut self, _signed: Vec<u8>) -> Result<String> {
            self.finalized += 1;
            Ok(format!("tx{}", self.finalized))
        }
        async fn broadcast(&mut self, _txid: &str) -> Result<()> {
            self.broadcasts += 1;
            Ok(())
        }
    }

    fn store_with(quote_id: &str, fee: u64) -> QuoteStore {
        let store = QuoteStore::open(&crate::store::tests::temp_db("withdraw")).unwrap();
        store.insert_withdrawal(quote_id, "uregtest1dest", 20_000, fee).unwrap();
        store
    }

    fn row(store: &QuoteStore, q: &str) -> Withdrawal {
        store.withdrawal(q).unwrap().unwrap()
    }

    #[tokio::test]
    async fn make_payment_twice_builds_one_tx() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 500, ..Default::default() };
        let first = make_payment(&store, &mut reserve, "q", Some(10_000)).await.unwrap();
        let second = make_payment(&store, &mut reserve, "q", Some(10_000)).await.unwrap();
        assert_eq!(first.state, Broadcast);
        assert_eq!(first.txid.as_deref(), Some("tx1"));
        assert_eq!(second, first);
        assert_eq!((reserve.builds, reserve.finalized, reserve.broadcasts), (1, 1, 1));
        assert_eq!(status_of(&second), MeltQuoteState::Pending);
    }

    #[test]
    fn in_flight_states_never_map_to_final() {
        let mut w = Withdrawal {
            quote_id: "q".into(),
            address: "a".into(),
            amount_zats: 1,
            fee_zats: 1,
            state: Unpaid,
            pczt_blob: None,
            txid: None,
            expiry_height: None,
            updated_at: 0,
            mined_at: None,
        };
        for s in [Built, Signing, Broadcast] {
            w.state = s;
            assert_eq!(status_of(&w), MeltQuoteState::Pending, "{s:?}");
        }
        let expected = HashMap::from([
            (Unpaid.as_str(), MeltQuoteState::Unpaid),
            (Mined.as_str(), MeltQuoteState::Paid),
            (Failed.as_str(), MeltQuoteState::Failed),
        ]);
        for s in [Unpaid, Mined, Failed] {
            w.state = s;
            assert_eq!(status_of(&w), expected[s.as_str()]);
        }
    }

    #[tokio::test]
    async fn fee_above_max_rejected_before_building() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 15_000, ..Default::default() };
        let err = make_payment(&store, &mut reserve, "q", Some(10_000)).await.unwrap_err();
        assert!(err.to_string().contains("exceeds"), "{err}");
        assert_eq!(reserve.builds, 0, "nothing may be built");
        assert_eq!(row(&store, "q").state, Unpaid, "still refundable as Unpaid");
    }

    #[tokio::test]
    async fn signing_failure_is_failed_and_never_broadcast() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, fail_sign: true, ..Default::default() };
        assert!(make_payment(&store, &mut reserve, "q", None).await.is_err());
        assert_eq!(row(&store, "q").state, Failed);
        assert_eq!((reserve.finalized, reserve.broadcasts), (0, 0));
    }

    #[tokio::test]
    async fn expiry_fails_only_past_expiry_and_unmined() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 100, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();

        let not_mined = chain(None);
        assert!(settle(&store, 100, 1, &not_mined).unwrap().is_empty(), "at expiry: still pending");
        assert_eq!(row(&store, "q").state, Broadcast);
        let s = settle(&store, 101, 1, &not_mined).unwrap();
        assert!(matches!(s.as_slice(), [Settled::Expired(_)]));
        assert_eq!(row(&store, "q").state, Failed);
        assert!(settle(&store, 102, 1, &not_mined).unwrap().is_empty(), "fails once");
    }

    #[tokio::test]
    async fn mined_settles_paid_once_even_past_expiry() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 100, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();
        let mined = chain(Some(at(100, "aa")));
        assert!(settle(&store, 100, 2, &mined).unwrap().is_empty(), "1 of 2 confirmations");
        let s = settle(&store, 105, 2, &mined).unwrap();
        assert!(matches!(s.as_slice(), [Settled::Paid(w)] if w.state == Mined));
        assert!(settle(&store, 106, 2, &mined).unwrap().is_empty(), "settles once");
    }

    fn at(height: u32, block_hash: &str) -> MinedAt {
        MinedAt { height, block_hash: block_hash.into() }
    }

    /// The mocked node: what it says about tx1 (the only txid in these tests).
    fn chain(tx1: Option<MinedAt>) -> HashMap<String, Option<MinedAt>> {
        HashMap::from([("tx1".to_string(), tx1)])
    }

    #[tokio::test]
    async fn reorg_before_depth_goes_back_to_pending_and_settles_on_new_block() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 500, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();

        // Mined in block A at 100; depth 3 not reached yet. The block is recorded.
        assert!(settle(&store, 101, 3, &chain(Some(at(100, "aa")))).unwrap().is_empty());
        assert_eq!(row(&store, "q").mined_at, Some(at(100, "aa")));
        assert_eq!(status_of(&row(&store, "q")), MeltQuoteState::Pending);

        // invalidateblock A: the tip drops to 99 and the node no longer has the tx mined.
        let s = settle(&store, 99, 3, &chain(None)).unwrap();
        assert!(matches!(s.as_slice(), [Settled::Reorged { w, was }] if w.state == Broadcast && *was == at(100, "aa")));
        let w = row(&store, "q");
        assert_eq!((w.state, w.mined_at.clone()), (Broadcast, None));
        assert_eq!(status_of(&w), MeltQuoteState::Pending, "not Failed: it can still be mined");
        assert!(settle(&store, 99, 3, &chain(None)).unwrap().is_empty(), "reported once");

        // Re-mined in a replacement block B at 101. Depth counts from B, not A.
        assert!(settle(&store, 102, 3, &chain(Some(at(101, "bb")))).unwrap().is_empty(), "2 of 3");
        assert_eq!(row(&store, "q").mined_at, Some(at(101, "bb")));
        let s = settle(&store, 103, 3, &chain(Some(at(101, "bb")))).unwrap();
        assert!(matches!(s.as_slice(), [Settled::Paid(w)] if w.mined_at == Some(at(101, "bb"))));
    }

    #[tokio::test]
    async fn moved_to_a_replacement_block_at_once_keeps_counting_from_the_new_block() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 500, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();
        assert!(settle(&store, 101, 3, &chain(Some(at(100, "aa")))).unwrap().is_empty());
        // Replaced by a longer chain where it sits at 102: 101..102 is only 1 confirmation.
        assert!(settle(&store, 102, 3, &chain(Some(at(102, "cc")))).unwrap().is_empty());
        assert_eq!(row(&store, "q").mined_at, Some(at(102, "cc")));
        assert!(matches!(settle(&store, 104, 3, &chain(Some(at(102, "cc")))).unwrap().as_slice(), [Settled::Paid(_)]));
    }

    #[tokio::test]
    async fn reorg_after_paid_is_reported_until_mined_again() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 500, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();
        assert!(matches!(settle(&store, 100, 1, &chain(Some(at(100, "aa")))).unwrap().as_slice(), [Settled::Paid(_)]));
        assert_eq!(txids_to_watch(&store, 150).unwrap(), ["tx1"], "watched while reorgable");

        for _ in 0..2 {
            let s = settle(&store, 99, 1, &chain(None)).unwrap();
            assert!(matches!(s.as_slice(), [Settled::ReorgedAfterPaid { was, .. }] if *was == at(100, "aa")));
        }
        assert_eq!(row(&store, "q").state, Mined, "PAID is final for the mint");
        assert!(settle(&store, 101, 1, &chain(Some(at(101, "bb")))).unwrap().is_empty());
        assert_eq!(row(&store, "q").mined_at, Some(at(101, "bb")));
        assert!(txids_to_watch(&store, 101 + REORG_WATCH_DEPTH).unwrap().is_empty(), "deep enough: no longer watched");
    }

    #[tokio::test]
    async fn txid_missing_from_the_snapshot_is_left_alone() {
        let store = store_with("q", 10_000);
        let mut reserve = FakeReserve { fee: 10_000, expiry: 100, ..Default::default() };
        make_payment(&store, &mut reserve, "q", None).await.unwrap();
        assert!(settle(&store, 200, 1, &HashMap::new()).unwrap().is_empty(), "no answer: not expired");
        assert_eq!(row(&store, "q").state, Broadcast);
    }

    #[tokio::test]
    async fn restart_fails_unbroadcast_and_keeps_broadcast() {
        let store = store_with("built", 10_000);
        store.insert_withdrawal("signing", "uregtest1dest", 20_000, 10_000).unwrap();
        store.insert_withdrawal("sent", "uregtest1dest", 20_000, 10_000).unwrap();
        store.mark_built("built", b"p", 10_000, 100).unwrap();
        store.mark_built("signing", b"p", 10_000, 100).unwrap();
        store.transition("signing", &[Built], Signing).unwrap();
        let mut reserve = FakeReserve { fee: 10_000, expiry: 100, ..Default::default() };
        make_payment(&store, &mut reserve, "sent", None).await.unwrap();

        let failed: Vec<String> = reconcile_unbroadcast(&store).unwrap().into_iter().map(|w| w.quote_id).collect();
        assert_eq!(failed, ["built", "signing"]);
        assert_eq!(row(&store, "sent").state, Broadcast);
        assert!(reconcile_unbroadcast(&store).unwrap().is_empty());
    }
}
