//! `ZecBackend`: cdk's `MintPayment` for the custom `zec` method (unit `zat`).
//!
//! Phase 1 is deposits only. Each mint quote gets a fresh diversified address of the mint's
//! reserve wallet; a background loop syncs the wallet, credits received Ironwood notes to
//! quotes by diversifier index, and emits one `PaymentReceived` per quote once it is paid and
//! confirmed. Withdrawals (melt) are Phase 2 and return "not supported yet".
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
use zec_wallet::Wallet;

use crate::{
    config::Config,
    store::{Quote, QuoteStore},
};

pub const METHOD: &str = "zec";
pub const UNIT: &str = "zat";

pub struct ZecBackend {
    cfg: Config,
    store: Arc<QuoteStore>,
    wallet: Arc<Mutex<Wallet>>,
    events: broadcast::Sender<Event>,
    stream_active: Arc<AtomicBool>,
    cancel_stream: Arc<Notify>,
    sync_task: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl ZecBackend {
    pub fn new(cfg: Config, store: QuoteStore, wallet: Wallet) -> Self {
        ZecBackend {
            cfg,
            store: Arc::new(store),
            wallet: Arc::new(Mutex::new(wallet)),
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

fn not_yet() -> Error {
    Error::Custom("ZEC withdrawals are not supported yet (Phase 2)".to_owned())
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
    let (tip, notes) = {
        let mut wallet = wallet.lock().await;
        let tip = wallet.sync().await?;
        (tip, wallet.received_notes()?)
    };
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
    Ok(())
}

#[async_trait]
impl MintPayment for ZecBackend {
    type Err = Error;

    async fn start(&self) -> Result<(), Self::Err> {
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
                    tracing::warn!("deposit sync failed (will retry): {e:#}");
                }
            }
        }));
        tracing::info!(?interval, confirmations, "deposit sync loop started");
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
        let rx = self.events.subscribe();
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
        let stream = events
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
        _unit: &CurrencyUnit,
        _options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        Err(not_yet())
    }

    async fn make_payment(
        &self,
        _unit: &CurrencyUnit,
        _options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        Err(not_yet())
    }

    async fn check_outgoing_payment(
        &self,
        _payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        Err(not_yet())
    }
}
