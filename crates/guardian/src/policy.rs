//! What a guardian checks before contributing a round-2 share. Nothing from the coordinator is
//! trusted: the quote comes from the mint itself, and everything about the transaction is
//! re-derived from the PCZT. `summarize` reads a PCZT; `check` is the pure policy (a)-(h).
use std::convert::Infallible;

use anyhow::{Result, anyhow};
use orchard::keys::FullViewingKey;
use zec_wallet::Pczt;

/// The melt quote as the mint reports it (`GET /v1/melt/quote/zec/{id}`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MintQuote {
    pub state: String,
    pub amount: u64,
    pub request: String,
    #[serde(default)]
    pub fee_reserve: u64,
    pub unit: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputInfo {
    /// Raw Orchard-format receiver.
    pub recipient: Option<[u8; 43]>,
    pub value: Option<u64>,
    /// The mint's own key can receive at this address (`fvk.scope_for_address` is Some).
    pub ours: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendInfo {
    pub value: Option<u64>,
    /// `verify_rk(Some(mint_fvk))` and `verify_nullifier(Some(mint_fvk))` passed.
    pub keys_ok: bool,
}

/// Everything the policy needs from a PCZT, computed by the guardian itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxSummary {
    pub spends: Vec<SpendInfo>,
    pub outputs: Vec<OutputInfo>,
    /// No transparent inputs/outputs and no Sapling spends/outputs.
    pub only_orchard_pools: bool,
    /// `verify_cross_address_restriction()` passed on both bundles.
    pub cross_address_ok: bool,
    pub sighash: [u8; 32],
    /// Spends needing a signature (alpha present, unsigned), in signing order.
    pub to_sign: usize,
}

pub fn summarize(pczt: &Pczt, fvk: &FullViewingKey) -> Result<TxSummary> {
    let mut spends = vec![];
    let mut outputs = vec![];
    let mut cross_address_ok = true;
    let mut read = |bundle: &orchard::pczt::Bundle| {
        cross_address_ok &= bundle.verify_cross_address_restriction().is_ok();
        for action in bundle.actions() {
            let spend = action.spend();
            spends.push(SpendInfo {
                value: spend.value().map(|v| v.inner()),
                keys_ok: spend.verify_rk(Some(fvk)).is_ok() && spend.verify_nullifier(Some(fvk)).is_ok(),
            });
            let out = action.output();
            outputs.push(OutputInfo {
                recipient: out.recipient().map(|a| a.to_raw_address_bytes()),
                value: out.value().map(|v| v.inner()),
                ours: out.recipient().is_some_and(|a| fvk.scope_for_address(&a).is_some()),
            });
        }
    };
    pczt::roles::verifier::Verifier::new(pczt.clone())
        .with_orchard::<Infallible, _>(|b| {
            read(b);
            Ok(())
        })
        .map_err(|e| anyhow!("invalid Orchard bundle: {e:?}"))?
        .with_ironwood::<Infallible, _>(|b| {
            read(b);
            Ok(())
        })
        .map_err(|e| anyhow!("invalid Ironwood bundle: {e:?}"))?;

    let only_orchard_pools = pczt.transparent().inputs().is_empty()
        && pczt.transparent().outputs().is_empty()
        && pczt.sapling().spends().is_empty()
        && pczt.sapling().outputs().is_empty();
    Ok(TxSummary {
        spends,
        outputs,
        only_orchard_pools,
        cross_address_ok,
        sighash: zec_wallet::frost::shielded_sighash(pczt)?,
        to_sign: zec_wallet::frost::spends_to_sign(pczt)?.len(),
    })
}

/// The policy. `quote_receiver` is the quote address's Orchard-format receiver;
/// `messages` the message of every signing package; `prior` the sighash this guardian already
/// signed for this quote, if any. Returns the refusal reason on failure.
pub fn check(
    quote: &MintQuote,
    quote_receiver: &[u8; 43],
    tx: &TxSummary,
    messages: &[Vec<u8>],
    prior: Option<[u8; 32]>,
) -> Result<(), String> {
    // a. the mint says this melt is in flight, in our unit
    if quote.state != "PENDING" {
        return Err(format!("(a) melt quote is {}, not PENDING", quote.state));
    }
    if !quote.unit.eq_ignore_ascii_case("zat") {
        return Err(format!("(a) melt quote unit is {}, not zat", quote.unit));
    }
    if !tx.only_orchard_pools {
        return Err("(c) transaction touches the transparent or Sapling pool".into());
    }

    // b. exactly one payment, of exactly the quoted amount, to the quoted receiver
    let paying: Vec<&OutputInfo> =
        tx.outputs.iter().filter(|o| o.value.unwrap_or(0) > 0 && o.recipient.as_ref() == Some(quote_receiver)).collect();
    match paying.as_slice() {
        [one] if one.value == Some(quote.amount) => {}
        [one] => {
            return Err(format!("(b) pays {:?} zat to the quote address, quote says {}", one.value, quote.amount));
        }
        many => return Err(format!("(b) {} outputs pay the quote address, expected exactly 1", many.len())),
    }

    // c. every other non-zero output goes back to the mint
    for o in &tx.outputs {
        if o.value.is_none() {
            return Err("(c) an output's value is missing".into());
        }
        let is_payment = o.recipient.as_ref() == Some(quote_receiver);
        if o.value.unwrap_or(0) > 0 && !is_payment && !o.ours {
            return Err("(c) an output sends value to an address that is not the mint's".into());
        }
    }

    // d. every spend is the mint's own note (including zero-value change-paired spends)
    if let Some(i) = tx.spends.iter().position(|s| !s.keys_ok) {
        return Err(format!("(d) action {i} fails verify_rk/verify_nullifier against the mint key"));
    }
    if tx.to_sign != messages.len() {
        return Err(format!("{} signing packages for {} spends", messages.len(), tx.to_sign));
    }

    // e. what leaves the mint's notes beyond the payment is at most the fee reserve
    let spent: u64 = tx.spends.iter().map(|s| s.value.ok_or("(e) a spend's value is missing")).sum::<Result<_, _>>()?;
    let output: u64 = tx.outputs.iter().map(|o| o.value.unwrap_or(0)).sum();
    let fee = spent.checked_sub(output).ok_or("(e) outputs exceed spends")?;
    if fee > quote.fee_reserve {
        return Err(format!("(e) fee {fee} zat exceeds the quote's fee reserve {} zat", quote.fee_reserve));
    }

    // f. Ironwood cross-address restriction
    if !tx.cross_address_ok {
        return Err("(f) cross-address restriction violated".into());
    }

    // g. we sign our own sighash, not whatever the coordinator says
    if messages.iter().any(|m| m.as_slice() != tx.sighash) {
        return Err("(g) a signing package's message is not this PCZT's shielded sighash".into());
    }

    // h. one transaction per quote, ever
    if let Some(prior) = prior
        && prior != tx.sighash
    {
        return Err("(h) already signed a different transaction for this quote".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEST: [u8; 43] = [7; 43];
    const MINT_CHANGE: [u8; 43] = [9; 43];
    const SIGHASH: [u8; 32] = [1; 32];

    fn quote() -> MintQuote {
        MintQuote { state: "PENDING".into(), amount: 20_000, request: "uregtest1dest".into(), fee_reserve: 10_000, unit: "zat".into() }
    }

    /// A valid withdrawal: spend 60000 of the mint's notes; pay 20000; 30000 change; 10000 fee;
    /// plus a zero-value padding action.
    fn tx() -> TxSummary {
        TxSummary {
            spends: vec![
                SpendInfo { value: Some(60_000), keys_ok: true },
                SpendInfo { value: Some(0), keys_ok: true },
            ],
            outputs: vec![
                OutputInfo { recipient: Some(DEST), value: Some(20_000), ours: false },
                OutputInfo { recipient: Some(MINT_CHANGE), value: Some(30_000), ours: true },
                OutputInfo { recipient: Some([3; 43]), value: Some(0), ours: false },
            ],
            only_orchard_pools: true,
            cross_address_ok: true,
            sighash: SIGHASH,
            to_sign: 1,
        }
    }

    fn msgs() -> Vec<Vec<u8>> {
        vec![SIGHASH.to_vec()]
    }

    fn refused(q: &MintQuote, t: &TxSummary, m: &[Vec<u8>], prior: Option<[u8; 32]>) -> String {
        check(q, &DEST, t, m, prior).expect_err("must refuse")
    }

    #[test]
    fn valid_withdrawal_is_signed() {
        assert_eq!(check(&quote(), &DEST, &tx(), &msgs(), None), Ok(()));
        // A retry of the same transaction for the same quote is fine.
        assert_eq!(check(&quote(), &DEST, &tx(), &msgs(), Some(SIGHASH)), Ok(()));
    }

    #[test]
    fn a_quote_not_pending() {
        for state in ["UNPAID", "PAID", "FAILED"] {
            let q = MintQuote { state: state.into(), ..quote() };
            assert!(refused(&q, &tx(), &msgs(), None).starts_with("(a)"));
        }
        let q = MintQuote { unit: "sat".into(), ..quote() };
        assert!(refused(&q, &tx(), &msgs(), None).starts_with("(a)"));
    }

    #[test]
    fn b_wrong_amount_or_destination() {
        let mut t = tx();
        t.outputs[0].value = Some(25_000);
        t.outputs[1].value = Some(25_000);
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(b)"));

        let mut t = tx();
        t.outputs[0].recipient = Some([5; 43]);
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(b)"));

        let mut t = tx();
        t.outputs.push(OutputInfo { recipient: Some(DEST), value: Some(1), ours: false });
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(b)"));
    }

    #[test]
    fn c_value_to_a_stranger() {
        let mut t = tx();
        t.outputs[1].ours = false;
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(c)"));

        let mut t = tx();
        t.only_orchard_pools = false;
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(c)"));
    }

    #[test]
    fn d_spend_not_the_mints() {
        let mut t = tx();
        t.spends[1].keys_ok = false; // even a zero-value spend
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(d)"));
    }

    #[test]
    fn e_fee_above_reserve() {
        let mut t = tx();
        t.outputs[1].value = Some(25_000); // fee becomes 15000 > 10000
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(e)"));
    }

    #[test]
    fn f_cross_address() {
        let mut t = tx();
        t.cross_address_ok = false;
        assert!(refused(&quote(), &t, &msgs(), None).starts_with("(f)"));
    }

    #[test]
    fn g_message_is_not_our_sighash() {
        assert!(refused(&quote(), &tx(), &[vec![2; 32]], None).starts_with("(g)"));
    }

    #[test]
    fn h_different_tx_for_same_quote() {
        assert!(refused(&quote(), &tx(), &msgs(), Some([2; 32])).starts_with("(h)"));
    }
}
