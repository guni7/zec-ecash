//! Locked point-of-sale payments: the server never holds spendable money.
//!
//! Each request carries a fresh P2PK key from the payee's phone (derived from its wallet seed,
//! one key per request). Payers lock their proofs to that key. On delivery the server checks the
//! payment without claiming anything (it can't: it doesn't have the key) and stores the token;
//! the phone then fetches it with a request signed by the request's key, redeems it at the mint
//! (a swap with NUT-11 witnesses), and acknowledges, after which the server deletes its copy.
//!
//!   GET  /requests/{id}/payment   signed "collect"  -> {id, amount, received, state, token?, collected,
//!                                                      extras: [{n, received, token?, collected}]}
//!   POST /requests/{id}/ack       signed "ack"      -> {ok}  (only once the proofs are spent)
//!   POST /requests/{id}/ack?extra=<n>  signed "ack" over "<id>/extra/<n>": the same, for extra payment n
//!
//! Never refused: a payment only the payee can spend. One that loses the race for an UNPAID
//! request, or arrives after it is PAID, is kept as extra payment n; one short of the request
//! (on time or late) is kept as a partial payment n and the request stays as it was. The payee
//! collects both kinds and can refund them by hand. Only a payment failing a safety check
//! (mint, unit, exact lock, no locktime/refund/extra keys, DLEQ, unspent, Y not reused) is refused.
//!   GET  /keys/{pubkey}/requests  signed "lookup"   -> {requests: [...]}  (a restored wallet)
//!
//! Signed = headers `x-pos-time` (unix seconds, within 60 s of the server's clock) and `x-pos-sig`:
//! a BIP-340 Schnorr signature by the request's key over SHA-256 of
//! `zec-ecash-pos-v1\n<action>\n<id or pubkey>\n<time>` (cdk's PublicKey::verify).
//!
//! A compromised server learns amounts and timing, and can withhold or delete payments, but
//! cannot spend them.
use std::str::FromStr;

use axum::{
    Json,
    extract::{Path as UrlPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use cdk::nuts::{CurrencyUnit, PaymentRequestPayload, Proofs, ProofsMethods, PublicKey, SigFlag, SpendingConditions, State as ProofState, Token};
use cdk_common::wallet::KeysetLoadPolicy;
use cdk_common::bitcoin::secp256k1::schnorr::Signature;
use rusqlite::{OptionalExtension, params};

use crate::{Pos, Shared, UNIT, err, now};

/// How far `x-pos-time` may be from the server's clock.
pub const SIG_WINDOW_SECS: u64 = 60;

/// The bytes a phone signs (SHA-256'd by the signature scheme) to collect, ack or look up.
pub fn auth_message(action: &str, subject: &str, time: u64) -> String {
    format!("zec-ecash-pos-v1\n{action}\n{subject}\n{time}")
}

/// Checks the request's signature headers against `key`.
fn authorize(headers: &HeaderMap, key: &PublicKey, action: &str, subject: &str) -> Result<(), Box<Response>> {
    let bad = |m: &str| Box::new(err(StatusCode::UNAUTHORIZED, m.to_owned()));
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let time: u64 = header("x-pos-time").and_then(|v| v.parse().ok()).ok_or_else(|| bad("missing x-pos-time"))?;
    if now().abs_diff(time) > SIG_WINDOW_SECS {
        return Err(bad("signature expired: x-pos-time is more than 60 s from the server's clock"));
    }
    let sig = header("x-pos-sig").and_then(|v| Signature::from_str(v).ok()).ok_or_else(|| bad("missing or malformed x-pos-sig"))?;
    key.verify(auth_message(action, subject, time).as_bytes(), &sig)
        .map_err(|_| bad("bad signature: not signed by this request's key"))
}

/// The safety checks that need no network: mint, unit, and that every proof is P2PK-locked to
/// exactly `key` with no locktime, refund keys, extra pubkeys or SIG_ALL, and carries a DLEQ
/// proof. Returns the amount received. The amount is not a safety check: a payment only the
/// payee can spend is never refused for being short (it becomes a partial payment).
pub fn check_locks(pos: &Pos, p: &PaymentRequestPayload, key: &PublicKey) -> Result<u64, String> {
    if p.mint != pos.mint {
        return Err(format!("wrong mint: this POS only accepts {}", pos.mint));
    }
    if p.unit != CurrencyUnit::custom(UNIT) {
        return Err(format!("wrong unit: {} (this POS only takes {UNIT})", p.unit));
    }
    if p.proofs.is_empty() {
        return Err("the payment has no proofs".into());
    }
    let received: u64 = p.proofs.iter().map(|x| u64::from(x.amount)).sum();
    for (i, proof) in p.proofs.iter().enumerate() {
        match SpendingConditions::try_from(&proof.secret) {
            Ok(SpendingConditions::P2PKConditions { data, conditions }) => {
                if data != *key {
                    return Err(format!("proof {i} is locked to a different key than this request's"));
                }
                if let Some(c) = conditions {
                    if c.locktime.is_some() || c.refund_keys.as_ref().is_some_and(|v| !v.is_empty()) || c.num_sigs_refund.is_some() {
                        return Err(format!("proof {i} has a locktime or refund keys; pay with a plain lock to the request's key"));
                    }
                    if c.pubkeys.as_ref().is_some_and(|v| !v.is_empty()) || c.num_sigs.is_some_and(|n| n != 1) {
                        return Err(format!("proof {i} names extra pubkeys or a multisig; pay with a plain lock to the request's key"));
                    }
                    if c.sig_flag != SigFlag::SigInputs {
                        return Err(format!("proof {i} uses SIG_ALL; pay with a plain lock to the request's key"));
                    }
                }
            }
            Ok(_) => return Err(format!("proof {i} is not P2PK-locked (see the request's nut10)")),
            Err(_) => return Err(format!("proof {i} is not locked to this request's key (see the request's nut10)")),
        }
        if proof.dleq.is_none() {
            return Err(format!("proof {i} has no DLEQ proof; send the token with DLEQ proofs"));
        }
    }
    Ok(received)
}

/// NUT-12: every proof's DLEQ verifies against the mint's key for its keyset and amount.
async fn check_dleq(pos: &Pos, proofs: &Proofs) -> Result<(), String> {
    for (i, p) in proofs.iter().enumerate() {
        let keyset = match pos.wallet.keyset(p.keyset_id).await {
            Ok(k) => k,
            // A keyset the server hasn't cached yet: ask the mint.
            Err(_) => pos
                .wallet
                .keyset_with_policy(p.keyset_id, KeysetLoadPolicy::Refresh)
                .await
                .map_err(|e| format!("proof {i}: keyset {} is not this mint's: {e}", p.keyset_id))?,
        };
        if keyset.unit != CurrencyUnit::custom(UNIT) {
            return Err(format!("proof {i}: keyset {} is not in {UNIT}", p.keyset_id));
        }
        let mint_key = keyset.keys.amount_key(p.amount).ok_or_else(|| format!("proof {i}: the mint has no key for amount {}", p.amount))?;
        p.verify_dleq(mint_key).map_err(|e| format!("proof {i}: invalid DLEQ proof, not signed by this mint ({e})"))?;
    }
    Ok(())
}

fn ys_hex(proofs: &Proofs) -> Result<Vec<String>, String> {
    Ok(proofs.ys().map_err(|e| format!("bad proof: {e}"))?.iter().map(|y| y.to_hex()).collect())
}

/// Delivery of a payment for a locked request: checks, claims the request (PROCESSING), asks the
/// mint that the proofs are unspent, then stores the token and marks it PAID. Claims nothing.
pub async fn pay(pos: &Pos, id: &str, quote_amount: u64, key: &PublicKey, p: PaymentRequestPayload) -> Response {
    // First: a proof already accepted for any request is refused as such (by Y).
    let ys = match ys_hex(&p.proofs) {
        Ok(ys) => ys,
        Err(m) => return err(StatusCode::BAD_REQUEST, m),
    };
    {
        let db = pos.db.lock().unwrap();
        for y in &ys {
            match db.query_row("SELECT 1 FROM pos_proof WHERE y = ?1", [y], |_| Ok(())).optional() {
                Ok(None) => {}
                Ok(Some(())) => return err(StatusCode::CONFLICT, "a proof in this payment was already accepted for another request"),
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
            }
        }
    }
    let received = match check_locks(pos, &p, key) {
        Ok(r) => r,
        Err(m) => return err(StatusCode::BAD_REQUEST, m),
    };
    if let Err(m) = check_dleq(pos, &p.proofs).await {
        return err(StatusCode::BAD_REQUEST, m);
    }

    // Never refuse a payment only the payee can spend. A full payment claims the request
    // atomically (of two concurrent payments one wins); one that loses, or arrives after the
    // request is PAID, is kept as an extra payment. A short one is kept as a partial payment and
    // the request stays as it is. The payee collects both kinds and can refund them.
    let partial = received < quote_amount;
    let main = !partial
        && match pos.db.lock().unwrap().execute("UPDATE pos_quote SET state = 'PROCESSING' WHERE id = ?1 AND state = 'UNPAID'", [id]) {
            Ok(n) => n == 1,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
        };
    let release = |pos: &Pos| {
        if main {
            let _ = pos.db.lock().unwrap().execute("UPDATE pos_quote SET state = 'UNPAID' WHERE id = ?1 AND state = 'PROCESSING'", [id]);
        }
    };

    // NUT-07: unspent (not already redeemed, not in another payment's flight).
    match pos.wallet.check_proofs_spent(p.proofs.clone()).await {
        Ok(states) if states.len() == p.proofs.len() && states.iter().all(|s| s.state == ProofState::Unspent) => {}
        Ok(_) => {
            release(pos);
            return err(StatusCode::BAD_REQUEST, "a proof in this payment is already spent (or being spent) at the mint");
        }
        Err(e) => {
            release(pos);
            return err(StatusCode::BAD_GATEWAY, format!("cannot check the proofs with the mint: {e}"));
        }
    }

    let token = Token::new(pos.mint.clone(), p.proofs.clone(), p.memo.clone(), CurrencyUnit::custom(UNIT)).to_string();
    let proofs_json = match serde_json::to_string(&p.proofs) {
        Ok(j) => j,
        Err(e) => {
            release(pos);
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("encode: {e}"));
        }
    };
    // One transaction: the proofs' Ys, then the request (main) or a new extra payment. Anything
    // failing rolls all of it back (the transaction is dropped uncommitted).
    let stored = (|| -> rusqlite::Result<Option<i64>> {
        let mut db = pos.db.lock().unwrap();
        let tx = db.transaction()?;
        for y in &ys {
            // PRIMARY KEY: a proof can back one payment only, even under a race.
            tx.execute("INSERT INTO pos_proof (y, quote_id) VALUES (?1, ?2)", params![y, id])?;
        }
        let extra = if main {
            let n = tx.execute(
                "UPDATE pos_quote SET state = 'PAID', received = ?2, token = ?3, proofs = ?4, paid_at = ?5
                 WHERE id = ?1 AND state = 'PROCESSING'",
                params![id, received as i64, token, proofs_json, now() as i64],
            )?;
            if n != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            None
        } else {
            let n: i64 = tx.query_row("SELECT COALESCE(MAX(n), 0) + 1 FROM pos_extra WHERE quote_id = ?1", [id], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO pos_extra (quote_id, n, received, token, proofs, paid_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, n, received as i64, token, proofs_json, now() as i64, if partial { "partial" } else { "extra" }],
            )?;
            Some(n)
        };
        tx.commit()?;
        Ok(extra)
    })();
    match stored {
        Ok(None) => {
            tracing::info!(%id, received, "PAID (locked to the payee's key; stored for collection)");
            Json(serde_json::json!({ "id": id, "state": "PAID", "received": received })).into_response()
        }
        Ok(Some(n)) if partial => {
            tracing::info!(%id, n, received, requested = quote_amount, "partial payment (short; stored for the payee)");
            let state: String = pos.db.lock().unwrap().query_row("SELECT state FROM pos_quote WHERE id = ?1", [id], |r| r.get(0)).unwrap_or_default();
            Json(serde_json::json!({
                "id": id,
                "state": state,
                "partial": true,
                "received": received,
                "requested": quote_amount,
                "note": format!("underpayment: received {received} of {quote_amount} zat; kept for the payee (who can refund it); the request is not paid by it"),
            }))
            .into_response()
        }
        Ok(Some(n)) => {
            tracing::info!(%id, n, received, "extra payment (request already paid; stored for the payee)");
            Json(serde_json::json!({
                "id": id,
                "state": "PAID",
                "extra": true,
                "received": received,
                "note": "this request was already paid; your payment was kept for the payee, who can refund it",
            }))
            .into_response()
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            release(pos);
            err(StatusCode::CONFLICT, "request is already paid")
        }
        Err(e) => {
            release(pos);
            if matches!(e, rusqlite::Error::SqliteFailure(ref f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation) {
                err(StatusCode::CONFLICT, "a proof in this payment was already accepted for another request")
            } else {
                err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"))
            }
        }
    }
}

struct Locked {
    key: PublicKey,
    amount: u64,
    received: u64,
    state: String,
    token: Option<String>,
    proofs: Option<String>,
    collected_at: Option<i64>,
}

fn load(pos: &Pos, id: &str) -> Result<Option<Locked>, Box<Response>> {
    let row = pos
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT pubkey, amount, received, state, token, proofs, collected_at FROM pos_quote WHERE id = ?1 AND pubkey IS NOT NULL",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .map_err(|e| Box::new(err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"))))?;
    let Some((key, amount, received, state, token, proofs, collected_at)) = row else { return Ok(None) };
    let key = PublicKey::from_hex(&key).map_err(|e| Box::new(err(StatusCode::INTERNAL_SERVER_ERROR, format!("stored key: {e}"))))?;
    Ok(Some(Locked { key, amount: amount as u64, received: received as u64, state, token, proofs, collected_at }))
}

/// Extra and partial payments stored for a request: (n, received, token, proofs, collected_at, kind).
type Extra = (i64, i64, Option<String>, Option<String>, Option<i64>, String);

fn extras(pos: &Pos, id: &str) -> Vec<Extra> {
    let db = pos.db.lock().unwrap();
    let Ok(mut stmt) = db.prepare("SELECT n, received, token, proofs, collected_at, kind FROM pos_extra WHERE quote_id = ?1 ORDER BY n") else { return vec![] };
    stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .and_then(|it| it.collect())
        .unwrap_or_default()
}

fn view(pos: &Pos, id: &str, l: &Locked, with_token: bool) -> serde_json::Value {
    let ex = extras(pos, id);
    serde_json::json!({
        "id": id,
        "amount": l.amount,
        "received": l.received,
        "state": l.state,
        "token": if with_token { l.token.clone() } else { None },
        "has_payment": l.token.is_some() || ex.iter().any(|e| e.2.is_some()),
        "collected": l.collected_at.is_some(),
        "extras": ex.iter().map(|(n, received, token, _, collected_at, kind)| serde_json::json!({
            "n": n,
            "kind": kind,
            "received": received,
            "token": if with_token { token.clone() } else { None },
            "collected": collected_at.is_some(),
        })).collect::<Vec<_>>(),
    })
}

/// GET /requests/{id}/payment: the stored token, to the holder of the request's key only.
pub async fn collect(State(pos): State<Shared>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Response {
    let l = match load(&pos, &id) {
        Ok(Some(l)) => l,
        Ok(None) => return err(StatusCode::NOT_FOUND, "unknown payment request"),
        Err(r) => return *r,
    };
    if let Err(r) = authorize(&headers, &l.key, "collect", &id) {
        return *r;
    }
    Json(view(&pos, &id, &l, true)).into_response()
}

#[derive(serde::Deserialize)]
pub struct AckQuery {
    /// Acknowledge extra payment `n` (signed subject `<id>/extra/<n>`) instead of the main one.
    extra: Option<i64>,
}

/// POST /requests/{id}/ack[?extra=n]: the phone has redeemed the payment; delete the server's
/// copy. Only once the mint reports the proofs spent, so a premature ack can't lose a payment.
pub async fn ack(State(pos): State<Shared>, UrlPath(id): UrlPath<String>, Query(q): Query<AckQuery>, headers: HeaderMap) -> Response {
    let l = match load(&pos, &id) {
        Ok(Some(l)) => l,
        Ok(None) => return err(StatusCode::NOT_FOUND, "unknown payment request"),
        Err(r) => return *r,
    };
    let subject = match q.extra {
        Some(n) => format!("{id}/extra/{n}"),
        None => id.clone(),
    };
    if let Err(r) = authorize(&headers, &l.key, "ack", &subject) {
        return *r;
    }
    let (proofs, collected) = match q.extra {
        None => (l.proofs.clone(), l.collected_at.is_some()),
        Some(n) => match extras(&pos, &id).into_iter().find(|e| e.0 == n) {
            Some(e) => (e.3, e.4.is_some()),
            None => return err(StatusCode::NOT_FOUND, "no such extra payment"),
        },
    };
    if collected {
        return Json(serde_json::json!({ "ok": true, "already": true })).into_response();
    }
    let Some(proofs) = proofs.as_deref() else {
        return err(StatusCode::CONFLICT, "nothing to acknowledge: the request is not paid yet");
    };
    let proofs: Proofs = match serde_json::from_str(proofs) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("stored proofs: {e}")),
    };
    match pos.wallet.check_proofs_spent(proofs.clone()).await {
        Ok(states) if states.len() == proofs.len() && states.iter().all(|s| s.state == ProofState::Spent) => {}
        Ok(_) => return err(StatusCode::CONFLICT, "not collected yet: the payment's proofs are still unspent at the mint"),
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("cannot check the proofs with the mint: {e}")),
    }
    let res = match q.extra {
        None => pos.db.lock().unwrap().execute(
            "UPDATE pos_quote SET token = NULL, proofs = NULL, collected_at = ?2 WHERE id = ?1",
            params![id, now() as i64],
        ),
        Some(n) => pos.db.lock().unwrap().execute(
            "UPDATE pos_extra SET token = NULL, proofs = NULL, collected_at = ?3 WHERE quote_id = ?1 AND n = ?2",
            params![id, n, now() as i64],
        ),
    };
    match res {
        Ok(_) => {
            tracing::info!(%id, extra = ?q.extra, "collected by the payee; stored copy deleted");
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
    }
}

/// GET /keys/{pubkey}/requests: which requests use this key (a wallet restored from its seed
/// re-derives its keys and finds its requests this way).
pub async fn lookup(State(pos): State<Shared>, UrlPath(pubkey): UrlPath<String>, headers: HeaderMap) -> Response {
    let Ok(key) = PublicKey::from_hex(&pubkey) else {
        return err(StatusCode::BAD_REQUEST, "not a public key");
    };
    if let Err(r) = authorize(&headers, &key, "lookup", &pubkey) {
        return *r;
    }
    let ids: Vec<String> = {
        let db = pos.db.lock().unwrap();
        let mut stmt = match db.prepare("SELECT id FROM pos_quote WHERE pubkey = ?1") {
            Ok(s) => s,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
        };
        match stmt.query_map([&key.to_hex()], |r| r.get(0)).and_then(|it| it.collect()) {
            Ok(v) => v,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")),
        }
    };
    let mut out = vec![];
    for id in ids {
        if let Ok(Some(l)) = load(&pos, &id) {
            out.push(view(&pos, &id, &l, false));
        }
    }
    Json(serde_json::json!({ "requests": out })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cdk::nuts::SecretKey;

    #[test]
    fn signature_round_trip_and_wrong_key() {
        let sk = SecretKey::generate();
        let msg = auth_message("collect", "abc", 1_800_000_000);
        let sig = sk.sign(msg.as_bytes()).unwrap();
        assert!(sk.public_key().verify(msg.as_bytes(), &sig).is_ok());
        assert!(SecretKey::generate().public_key().verify(msg.as_bytes(), &sig).is_err());
        // a collect signature is not an ack signature
        assert!(sk.public_key().verify(auth_message("ack", "abc", 1_800_000_000).as_bytes(), &sig).is_err());
    }
}
