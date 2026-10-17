//! `ZecBackend`: cdk's `MintPayment` for the custom `zec` method (unit `zat`).
//!
//! Deposits (Phase 1): each mint quote gets a fresh diversified address of the mint's reserve
//! wallet; a background loop syncs the wallet, credits received Ironwood notes to quotes by
//! diversifier index, and emits one `PaymentReceived` per quote once it is paid and confirmed.
//!
//! Withdrawals (Phase 2): a melt quote is priced with a ZIP 317 proposal; `make_payment` builds a
//! PCZT, has the [`Signer`] authorize it, proves, extracts and broadcasts it (see withdraw.rs
//! for the state machine and the never-refund-what-might-mine rule). The same loop settles
//! broadcast withdrawals: `PaymentSuccessful` once mined and confirmed, `PaymentFailed` only
//! once expired unmined.
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use cdk_common::{
    Amount, CurrencyUnit, QuoteId,
    nuts::MeltQuoteState,
    payment::{
        CreateIncomingPaymentResponse, Error, Event, IncomingPaymentOptions, MakePaymentResponse,
        MintPayment, OutgoingPaymentOptions, PaymentIdentifier, PaymentQuoteResponse,
        SettingsResponse, WaitPaymentResponse,
    },
};
use futures::{Stream, StreamExt};
use tokio::{
    sync::{Mutex, Notify, broadcast},
    task::JoinHandle,
};
use zec_wallet::{Pczt, Signer, Wallet};

use crate::{
    config::Config,
    store::{Quote, QuoteStore, Withdrawal, WithdrawalState},
    withdraw::{self, BuiltTx, Reserve, Settled},
};

pub const METHOD: &str = "zec";
pub const UNIT: &str = "zat";

pub struct ZecBackend {
    cfg: Config,
    store: Arc<QuoteStore>,
    wallet: Arc<Mutex<Wallet>>,
    signer: Arc<dyn Signer>,
    events: broadcast::Sender<Event>,
    stream_active: Arc<AtomicBool>,
    cancel_stream: Arc<Notify>,
    sync_task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl ZecBackend {
    pub fn new(cfg: Config, store: QuoteStore, wallet: Wallet, signer: Arc<dyn Signer>) -> Self {
        ZecBackend {
            cfg,
            store: Arc::new(store),
            wallet: Arc::new(Mutex::new(wallet)),
            signer,
            events: broadcast::channel(1024).0,
            stream_active: Arc::new(AtomicBool::new(false)),
            cancel_stream: Arc::new(Notify::new()),
            sync_task: std::sync::Mutex::new(None),
        }
    }

    fn unit() -> CurrencyUnit {
        CurrencyUnit::custom(UNIT)
    }

    /// Reserves the next diversifier index, registers its address with the reserve wallet,
    /// and stores the quote.
    async fn create_deposit(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Error> {
        let IncomingPaymentOptions::Custom(opts) = options else {
            return Err(Error::UnsupportedPaymentOption);
        };
        // cdk-payment-processor 0.18.2's gRPC server drops the method name (it always passes
        // ""), so "" means our only custom method.
        if !(opts.method.is_empty() || opts.method == METHOD) {
            return Err(Error::UnsupportedPaymentOption);
        }
        let amount = opts
            .amount
            .ok_or_else(|| Error::Custom("a zec deposit quote needs an amount".to_owned()))?;
        if !amount.unit().to_string().eq_ignore_ascii_case(UNIT) {
            return Err(Error::UnsupportedUnit);
        }
        let zats = amount.value();
        if zats < self.cfg.min_zats || zats > self.cfg.max_zats {
            return Err(Error::Custom(format!(
                "amount {zats} zat outside {}..={} zat",
                self.cfg.min_zats, self.cfg.max_zats
            )));
        }
        let expires_at = opts.unix_expiry.unwrap_or_else(|| now() + 3600);
        let quote_id = opts.quote_id.to_string();

        // Holding the wallet lock across reserve+derive keeps address registration and the
        // quote row consistent; it may wait for a sync pass in progress.
        let mut wallet = self.wallet.lock().await;
        let quote = self
            .store
            .create_quote(&quote_id, zats, expires_at, |index| wallet.address_at(index))
            .map_err(backend_err)?;
        drop(wallet);

        tracing::info!(%quote_id, index = quote.diversifier_index, zats, "deposit address issued");
        Ok(CreateIncomingPaymentResponse {
            request_lookup_id: PaymentIdentifier::QuoteId(opts.quote_id),
            request: quote.address,
            expiry: Some(quote.expires_at),
            extra_json: None,
        })
    }
}

impl ZecBackend {
    /// Validates the destination, prices the fee and records an UNPAID withdrawal.
    async fn quote_withdrawal(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Error> {
        let OutgoingPaymentOptions::Custom(opts) = options else {
            return Err(Error::UnsupportedPaymentOption);
        };
        if !unit.to_string().eq_ignore_ascii_case(UNIT) {
            return Err(Error::UnsupportedUnit);
        }
        let zats = opts
            .amount
            .ok_or_else(|| Error::Custom("a zec withdrawal quote needs an amount".to_owned()))?
            .value();
        if zats < self.cfg.min_zats || zats > self.cfg.max_zats {
            return Err(Error::Custom(format!(
                "amount {zats} zat outside {}..={} zat",
                self.cfg.min_zats, self.cfg.max_zats
            )));
        }
        let address = opts.request.trim().to_owned();
        zec_wallet::validate_withdrawal_address(&address).map_err(backend_err)?;
        let fee = self.wallet.lock().await.quote_fee(&address, zats).map_err(backend_err)?;
        let quote_id = opts.quote_id.to_string();
        self.store.insert_withdrawal(&quote_id, &address, zats, fee).map_err(backend_err)?;

        tracing::info!(%quote_id, zats, fee, "withdrawal quoted");
        Ok(PaymentQuoteResponse {
            request_lookup_id: Some(PaymentIdentifier::QuoteId(opts.quote_id)),
            amount: Amount::new(zats, Self::unit()),
            fee: Amount::new(fee, Self::unit()),
            state: MeltQuoteState::Unpaid,
            extra_json: None,
            estimated_blocks: Some(self.cfg.confirmations),
            fee_options: None,
        })
    }

    async fn run_withdrawal(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Error> {
        let OutgoingPaymentOptions::Custom(opts) = options else {
            return Err(Error::UnsupportedPaymentOption);
        };
        if !unit.to_string().eq_ignore_ascii_case(UNIT) {
            return Err(Error::UnsupportedUnit);
        }
        let quote_id = opts.quote_id.to_string();
        let max_fee = opts.max_fee_amount.map(|a| a.value());

        // The wallet lock serializes withdrawals with each other and with the sync loop.
        let mut wallet = self.wallet.lock().await;
        let mut reserve = WalletReserve { wallet: &mut wallet, signer: self.signer.as_ref() };
        let w = withdraw::make_payment(&self.store, &mut reserve, &quote_id, max_fee)
            .await
            .map_err(backend_err)?;
        tracing::info!(%quote_id, state = w.state.as_str(), txid = ?w.txid, "withdrawal submitted");
        outgoing_response(&w)
    }

    /// Settlement events for withdrawals finished in the last day, replayed whenever the mint
    /// (re)opens the event stream. An event emitted while the mint was disconnected (e.g. it was
    /// still backing off after a processor restart) is otherwise lost, and the mint would keep
    /// the melt PENDING until someone polls it. The mint ignores events for melts that are no
    /// longer PENDING, so replays are harmless.
    fn settled_withdrawal_events(&self) -> anyhow::Result<Vec<Event>> {
        let since = now().saturating_sub(24 * 3600);
        let mut events = vec![];
        for w in self.store.withdrawals_in(&[WithdrawalState::Mined, WithdrawalState::Failed])? {
            if w.updated_at < since {
                continue;
            }
            let quote_id = parse_quote_id(&w.quote_id)?;
            events.push(match w.state {
                WithdrawalState::Mined => Event::PaymentSuccessful { quote_id, details: outgoing_response(&w)? },
                _ => Event::PaymentFailed { quote_id, reason: "withdrawal failed (replayed)".to_owned() },
            });
        }
        if !events.is_empty() {
            tracing::info!(count = events.len(), "replaying settled withdrawals to the mint");
        }
        Ok(events)
    }

    /// Startup reconciliation: unbroadcast BUILT/SIGNING rows fail (nothing reached the chain);
    /// BROADCAST rows are sent again and left to the watcher.
    async fn reconcile(&self) -> anyhow::Result<()> {
        for w in withdraw::reconcile_unbroadcast(&self.store)? {
            tracing::warn!(quote_id = %w.quote_id, "withdrawal never broadcast before restart: FAILED");
            emit_failed(&self.events, &w, "processor restarted before the transaction was broadcast");
        }
        let mut wallet = self.wallet.lock().await;
        for w in self.store.withdrawals_in(&[WithdrawalState::Broadcast])? {
            if let Some(txid) = &w.txid {
                match rebroadcast(&mut wallet, txid).await {
                    Ok(()) => tracing::info!(quote_id = %w.quote_id, %txid, "rebroadcast after restart"),
                    Err(e) => tracing::info!(quote_id = %w.quote_id, %txid, "rebroadcast after restart: {e:#}"),
                }
            }
        }
        Ok(())
    }
}

/// The reserve wallet plus the signer, as the withdrawal pipeline sees them.
struct WalletReserve<'a> {
    wallet: &'a mut Wallet,
    signer: &'a dyn Signer,
}

fn pczt_bytes(pczt: Pczt) -> anyhow::Result<Vec<u8>> {
    pczt.serialize().map_err(|e| anyhow::anyhow!("cannot serialize PCZT: {e:?}"))
}

fn parse_pczt(bytes: &[u8]) -> anyhow::Result<Pczt> {
    Pczt::parse(bytes).map_err(|e| anyhow::anyhow!("cannot parse PCZT: {e:?}"))
}

#[async_trait]
impl Reserve for WalletReserve<'_> {
    fn quote_fee(&mut self, to: &str, zats: u64) -> anyhow::Result<u64> {
        self.wallet.quote_fee(to, zats)
    }

    fn build(&mut self, to: &str, zats: u64) -> anyhow::Result<BuiltTx> {
        let built = self.wallet.build_pczt(to, zats)?;
        Ok(BuiltTx { pczt: pczt_bytes(built.pczt)?, fee: built.fee, expiry_height: built.expiry_height })
    }

    async fn sign(&mut self, pczt: Vec<u8>, quote_id: &str) -> anyhow::Result<Vec<u8>> {
        pczt_bytes(self.signer.sign(parse_pczt(&pczt)?, quote_id).await?)
    }

    fn finalize(&mut self, signed: Vec<u8>) -> anyhow::Result<String> {
        Ok(self.wallet.prove_and_extract(parse_pczt(&signed)?)?.to_string())
    }

    async fn broadcast(&mut self, txid: &str) -> anyhow::Result<()> {
        rebroadcast(self.wallet, txid).await
    }
}

async fn rebroadcast(wallet: &mut Wallet, txid: &str) -> anyhow::Result<()> {
    wallet.broadcast(zec_wallet::parse_txid(txid)?).await
}

/// What the mint is told about a withdrawal. Only MINED carries the amount spent and the txid.
fn outgoing_response(w: &Withdrawal) -> Result<MakePaymentResponse, Error> {
    let status = withdraw::status_of(w);
    let paid = status == MeltQuoteState::Paid;
    Ok(MakePaymentResponse {
        payment_lookup_id: PaymentIdentifier::QuoteId(parse_quote_id(&w.quote_id)?),
        payment_proof: if paid { w.txid.clone() } else { None },
        status,
        total_spent: Amount::new(if paid { w.amount_zats + w.fee_zats } else { 0 }, ZecBackend::unit()),
    })
}

fn emit_failed(events: &broadcast::Sender<Event>, w: &Withdrawal, reason: &str) {
    match parse_quote_id(&w.quote_id) {
        Ok(quote_id) => {
            let _ = events.send(Event::PaymentFailed { quote_id, reason: reason.to_owned() });
        }
        Err(e) => tracing::warn!("cannot report failed withdrawal {}: {e}", w.quote_id),
    }
}

/// What the mint is told about a paid quote. `payment_id` is fixed per quote, so even if this
/// is delivered twice (stream + status poll) the mint records it once.
fn paid_response(quote: &Quote) -> Result<WaitPaymentResponse, Error> {
    Ok(WaitPaymentResponse {
        payment_identifier: PaymentIdentifier::QuoteId(parse_quote_id(&quote.quote_id)?),
        payment_amount: Amount::new(quote.received_zats, ZecBackend::unit()),
        payment_id: format!("zec-deposit:{}", quote.quote_id),
    })
}

fn parse_quote_id(s: &str) -> Result<QuoteId, Error> {
    s.parse().map_err(|_| Error::Custom(format!("invalid quote id {s}")))
}

fn backend_err(e: anyhow::Error) -> Error {
    Error::Anyhow(e)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One pass: sync the reserve wallet, credit new notes, emit events for newly paid quotes.
async fn sync_once(
    wallet: &Mutex<Wallet>,
    store: &QuoteStore,
    events: &broadcast::Sender<Event>,
    min_confirmations: u32,
) -> anyhow::Result<()> {
    let mut wallet = wallet.lock().await;
    let tip = wallet.sync().await?;
    let notes = wallet.received_notes()?;
    for quote in store.apply_notes(&notes, tip, min_confirmations)? {
        tracing::info!(
            quote_id = %quote.quote_id,
            received_zats = quote.received_zats,
            confirmations = quote.confirmations,
            "deposit paid"
        );
        // No subscriber right now is fine: the mint also polls check_incoming_payment_status.
        let _ = events.send(Event::PaymentReceived(paid_response(&quote)?));
    }

    // Withdrawals: settle BROADCAST rows, then resend the ones still waiting to be mined.
    let settled = withdraw::settle(store, tip, min_confirmations, |txid| {
        wallet.tx_mined_height(zec_wallet::parse_txid(txid)?)
    })?;
    for s in settled {
        match s {
            Settled::Paid(w) => {
                tracing::info!(quote_id = %w.quote_id, txid = ?w.txid, "withdrawal mined");
                let _ = events.send(Event::PaymentSuccessful {
                    quote_id: parse_quote_id(&w.quote_id)?,
                    details: outgoing_response(&w)?,
                });
            }
            Settled::Expired(w) => {
                tracing::warn!(quote_id = %w.quote_id, txid = ?w.txid, expiry = ?w.expiry_height, "withdrawal expired unmined");
                let reason = format!(
                    "transaction {} expired at height {} without being mined",
                    w.txid.as_deref().unwrap_or("?"),
                    w.expiry_height.unwrap_or(0)
                );
                emit_failed(events, &w, &reason);
            }
        }
    }
    for w in store.withdrawals_in(&[WithdrawalState::Broadcast])? {
        if let Some(txid) = &w.txid
            && let Err(e) = rebroadcast(&mut wallet, txid).await
        {
            tracing::debug!(%txid, "rebroadcast: {e:#}");
        }
    }
    Ok(())
}

#[async_trait]
impl MintPayment for ZecBackend {
    type Err = Error;

    async fn start(&self) -> Result<(), Self::Err> {
        self.reconcile().await.map_err(backend_err)?;
        let mut task = self.sync_task.lock().unwrap();
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok(());
        }
        let (wallet, store, events) = (self.wallet.clone(), self.store.clone(), self.events.clone());
        let (interval, confirmations) = (self.cfg.sync_interval, self.cfg.confirmations);
        *task = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(e) = sync_once(&wallet, &store, &events, confirmations).await {
                    tracing::warn!("sync pass failed (will retry): {e:#}");
                }
            }
        }));
        tracing::info!(?interval, confirmations, "sync loop started (deposits + withdrawals)");
        Ok(())
    }

    async fn stop(&self) -> Result<(), Self::Err> {
        if let Some(task) = self.sync_task.lock().unwrap().take() {
            task.abort();
        }
        self.cancel_payment_event_stream();
        Ok(())
    }

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        // cdk-mintd registers every key of `custom` as a payment method; the value is
        // informational (the mint's own min/max come from its config).
        let zec = format!(
            r#"{{"unit":"{UNIT}","min_amount":{},"max_amount":{},"confirmations":{},"pool":"ironwood"}}"#,
            self.cfg.min_zats, self.cfg.max_zats, self.cfg.confirmations
        );
        Ok(SettingsResponse {
            unit: UNIT.to_owned(),
            bolt11: None,
            bolt12: None,
            onchain: None,
            custom: HashMap::from([(METHOD.to_owned(), zec)]),
        })
    }

    async fn create_incoming_payment_request(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Self::Err> {
        // The gRPC server replaces our error with "Could not create invoice", so log it here.
        self.create_deposit(options)
            .await
            .inspect_err(|e| tracing::warn!("cannot create deposit quote: {e}"))
    }

    async fn wait_payment_event(
        &self,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, Self::Err> {
        // Subscribe before reading the store so nothing settled in between is missed.
        let rx = self.events.subscribe();
        let replay = self.settled_withdrawal_events().map_err(backend_err)?;
        let events = futures::stream::unfold(rx, |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(event) => return Some((event, rx)),
                    // Missed events are recovered by the mint's status polling.
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("payment event stream lagged by {n}");
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        });
        let cancel = self.cancel_stream.clone();
        let active = self.stream_active.clone();
        active.store(true, Ordering::SeqCst);
        let stream = futures::stream::iter(replay)
            .chain(events)
            .take_until(async move { cancel.notified().await })
            .chain(futures::stream::once(async move {
                active.store(false, Ordering::SeqCst);
            })
            .filter_map(|()| async { None }));
        Ok(Box::pin(stream))
    }

    fn is_payment_event_stream_active(&self) -> bool {
        self.stream_active.load(Ordering::SeqCst)
    }

    fn cancel_payment_event_stream(&self) {
        self.cancel_stream.notify_waiters();
    }

    async fn check_incoming_payment_status(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        let PaymentIdentifier::QuoteId(quote_id) = payment_identifier else {
            return Err(Error::UnsupportedPaymentOption);
        };
        match self.store.quote(&quote_id.to_string()).map_err(backend_err)? {
            Some(quote) if quote.paid_emitted => Ok(vec![paid_response(&quote)?]),
            Some(_) => Ok(vec![]),
            None => Err(Error::Custom(format!("unknown zec quote {quote_id}"))),
        }
    }

    async fn get_payment_quote(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        // The gRPC server replaces our error with a generic one, so log it here.
        self.quote_withdrawal(unit, options)
            .await
            .inspect_err(|e| tracing::warn!("cannot quote withdrawal: {e}"))
    }

    async fn make_payment(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        self.run_withdrawal(unit, options)
            .await
            .inspect_err(|e| tracing::warn!("withdrawal not submitted: {e}"))
    }

    async fn check_outgoing_payment(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        let PaymentIdentifier::QuoteId(quote_id) = payment_identifier else {
            return Err(Error::UnsupportedPaymentOption);
        };
        match self.store.withdrawal(&quote_id.to_string()).map_err(backend_err)? {
            Some(w) => outgoing_response(&w),
            None => Err(Error::Custom(format!("unknown zec withdrawal {quote_id}"))),
        }
    }
}
