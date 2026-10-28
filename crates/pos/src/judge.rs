//! Public judge links: anyone who asks gets the next judge link of the kit, one per browser.
//!
//!   GET  /judge/status                       -> {left, amount}  for the page's "Get test money" card
//!   POST /judge/claim  {"browser": "<id>"}   -> 200 {token, amount, again}
//!                                               410 none left, 404 no public kit, 502 mint unreachable
//!
//! The pool is only the kit's links marked public (`zec-ecash-cli judge-kit create … --public`),
//! read from <state>/judge-kit/kit.json (the CLI writes it on this host) on every request, so a
//! new kit or a reclaim applies without a restart. The most this can ever give away is those
//! links' total; links the organiser sends directly are never handed out here.
//!
//! One per browser: the page sends a random id it keeps; asking again with the same id returns
//! the same link (`again: true`), so a failed claim can be retried without taking a second one.
//! Clearing the browser's storage gets another, which the organiser accepted for this pool.
//! Which link went to which browser is kept in `judge_handout` (pos.sqlite). Before a link is
//! handed out the mint is asked (NUT-07) whether its proofs are unspent; a claimed or reclaimed
//! link is skipped and marked so it isn't asked about again.

use std::{path::Path, str::FromStr};

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use cdk::nuts::{KeySetInfo, State as ProofState, Token};
use cdk_common::wallet::KeysetLoadPolicy;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Pos, Shared, err, now};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS judge_handout (
     token   TEXT PRIMARY KEY,     -- the link's token (numbers restart in a new kit; tokens don't)
     n       INTEGER NOT NULL,     -- its number in the kit, for the log
     browser TEXT UNIQUE,          -- who got it; NULL: skipped (already spent at the mint)
     at      INTEGER NOT NULL
 );";

/// The kit's public links that aren't reclaimed: (n, amount, token).
fn pool(kit: &Path) -> Vec<(i64, u64, String)> {
    let Ok(text) = std::fs::read_to_string(kit) else { return vec![] };
    // {"judges": [...]}, as zec-ecash-cli writes it
    let Some(judges) = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["judges"].as_array().cloned()) else {
        tracing::warn!(kit = %kit.display(), "judge kit is not readable");
        return vec![];
    };
    judges
        .iter()
        .filter(|j| j["public"].as_bool() == Some(true) && j["reclaimed"].as_bool() != Some(true))
        .filter_map(|j| Some((j["n"].as_i64()?, j["amount"].as_u64()?, j["token"].as_str()?.to_owned())))
        .collect()
}

pub async fn status(State(pos): State<Shared>) -> Response {
    let links = pool(&pos.judge_kit);
    let taken: Vec<String> = {
        let db = pos.db.lock().unwrap();
        let mut st = db.prepare("SELECT token FROM judge_handout").expect("judge_handout");
        st.query_map([], |r| r.get(0)).expect("judge_handout").filter_map(Result::ok).collect()
    };
    let left: Vec<&(i64, u64, String)> = links.iter().filter(|(.., t)| !taken.contains(t)).collect();
    Json(json!({ "left": left.len(), "amount": left.first().map(|(_, a, _)| *a) })).into_response()
}

#[derive(Deserialize)]
pub struct ClaimBody {
    browser: String,
}

pub async fn claim(State(pos): State<Shared>, Json(body): Json<ClaimBody>) -> Response {
    let browser = body.browser.trim();
    if browser.len() < 16 || browser.len() > 64 || !browser.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return err(StatusCode::BAD_REQUEST, "browser: 16-64 letters, digits or dashes");
    }
    let links = pool(&pos.judge_kit);
    if links.is_empty() {
        return err(StatusCode::NOT_FOUND, "there are no public judge links on this server");
    }
    // This browser's link, if it has one.
    let mine: Option<String> = pos.db.lock().unwrap().query_row("SELECT token FROM judge_handout WHERE browser = ?1", [browser], |r| r.get(0)).optional().unwrap_or(None);
    if let Some(t) = mine {
        return match links.iter().find(|(.., u)| *u == t) {
            Some((_, amount, token)) => Json(json!({ "token": token, "amount": amount, "again": true })).into_response(),
            None => err(StatusCode::GONE, "the link this browser got was taken back by the organiser"),
        };
    }
    let infos = match keyset_infos(&pos).await {
        Ok(i) => i,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("cannot reach the mint: {e}")),
    };
    for (n, amount, token) in &links {
        // Reserve it for this browser first (two at once can't get the same link) ...
        let reserved = pos.db.lock().unwrap().execute("INSERT OR IGNORE INTO judge_handout (token, n, browser, at) VALUES (?1, ?2, ?3, ?4)", params![token, n, browser, now() as i64]);
        if !matches!(reserved, Ok(1)) {
            continue; // handed out or skipped already
        }
        // ... then make sure nobody has claimed it (NUT-07).
        match unspent(&pos, &infos, token).await {
            Ok(true) => {
                tracing::info!(n, amount, "judge link handed out");
                return Json(json!({ "token": token, "amount": amount, "again": false })).into_response();
            }
            Ok(false) => {
                let _ = pos.db.lock().unwrap().execute("UPDATE judge_handout SET browser = NULL WHERE token = ?1", [token]);
            }
            Err(e) => {
                let _ = pos.db.lock().unwrap().execute("DELETE FROM judge_handout WHERE token = ?1", [token]);
                return err(StatusCode::BAD_GATEWAY, format!("cannot check the link with the mint: {e}"));
            }
        }
    }
    err(StatusCode::GONE, "all the judge links have been claimed")
}

/// The mint's keysets (from the cache, else the mint), to read a token's proofs.
async fn keyset_infos(pos: &Pos) -> anyhow::Result<Vec<KeySetInfo>> {
    pos.wallet.keysets(KeysetLoadPolicy::CacheThenNetwork).await?;
    Ok(pos.wallet.localstore.get_mint_keysets(pos.mint.clone()).await?.unwrap_or_default())
}

/// Every proof of the token unspent at the mint.
async fn unspent(pos: &Pos, infos: &[KeySetInfo], token: &str) -> anyhow::Result<bool> {
    let proofs = Token::from_str(token)?.proofs(infos)?;
    let states = pos.wallet.check_proofs_spent(proofs).await?;
    Ok(!states.is_empty() && states.iter().all(|s| s.state == ProofState::Unspent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_is_the_public_links_not_reclaimed() {
        let dir = std::env::temp_dir().join(format!("pos-judge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let kit = dir.join("kit.json");
        // as zec-ecash-cli writes it
        let judges = json!({ "judges": [
            { "n": 1, "amount": 25000, "token": "cashuBdirect", "public": false },
            { "n": 2, "amount": 25000, "token": "cashuBpublic" , "public": true },
            { "n": 3, "amount": 25000, "token": "cashuBtaken", "public": true, "reclaimed": true },
            { "n": 4, "amount": 25000, "token": "cashuBold" },
        ] });
        std::fs::write(&kit, judges.to_string()).unwrap();
        assert_eq!(pool(&kit), vec![(2, 25000, "cashuBpublic".to_owned())]);
        std::fs::write(&kit, "not json").unwrap();
        assert!(pool(&kit).is_empty());
        assert!(pool(&dir.join("missing.json")).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
