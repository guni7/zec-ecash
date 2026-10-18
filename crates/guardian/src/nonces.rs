//! Round-1 nonces: memory only, keyed by (session, action), single use, 2-minute lifetime.
//! Round 2 *takes* a session's nonces out, so they are gone whether it signs or refuses.
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use zec_frost::redpallas::round1::SigningNonces;

pub const NONCE_TTL: Duration = Duration::from_secs(120);

struct Session {
    quote_id: String,
    created: Instant,
    nonces: Vec<SigningNonces>,
}

#[derive(Default)]
pub struct Nonces {
    sessions: HashMap<String, Session>,
}

impl Nonces {
    /// Stores a new session's nonces. A session id can only be used once.
    pub fn insert(&mut self, session: &str, quote_id: &str, nonces: Vec<SigningNonces>) -> Result<(), String> {
        self.expire();
        if self.sessions.contains_key(session) {
            return Err(format!("session {session} already has nonces"));
        }
        self.sessions.insert(
            session.to_owned(),
            Session { quote_id: quote_id.to_owned(), created: Instant::now(), nonces },
        );
        Ok(())
    }

    /// Removes and returns a session's nonces (they can never be used again).
    pub fn take(&mut self, session: &str, quote_id: &str) -> Result<Vec<SigningNonces>, String> {
        self.expire();
        let s = self.sessions.remove(session).ok_or("unknown or expired session")?;
        if s.quote_id != quote_id {
            return Err("session belongs to a different quote".into());
        }
        Ok(s.nonces)
    }

    /// Drops sessions older than [`NONCE_TTL`].
    pub fn expire(&mut self) {
        self.sessions.retain(|_, s| s.created.elapsed() < NONCE_TTL);
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zec_frost::redpallas as frost;

    fn nonce() -> SigningNonces {
        let mut rng = rand::thread_rng();
        let (shares, _) =
            frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, &mut rng).unwrap();
        let share = shares.into_values().next().unwrap();
        frost::round1::commit(share.signing_share(), &mut rng).0
    }

    #[test]
    fn nonce_deleted_after_use() {
        let mut n = Nonces::default();
        n.insert("s", "q", vec![nonce()]).unwrap();
        assert!(n.take("s", "q").is_ok());
        assert_eq!(n.len(), 0);
        assert!(n.take("s", "q").is_err(), "a nonce is usable once");
        assert!(n.insert("s", "q", vec![nonce()]).is_ok(), "the id is free again only because it was removed");
    }

    #[test]
    fn session_ids_and_quotes_cannot_be_mixed() {
        let mut n = Nonces::default();
        n.insert("s", "q", vec![nonce()]).unwrap();
        assert!(n.insert("s", "q", vec![nonce()]).is_err(), "no overwriting live nonces");
        assert!(n.take("s", "other-quote").is_err());
        assert!(n.take("s", "q").is_err(), "a mismatched take still burns the nonces");
    }

    #[test]
    fn nonces_expire() {
        let mut n = Nonces::default();
        n.insert("s", "q", vec![nonce()]).unwrap();
        n.sessions.get_mut("s").unwrap().created -= NONCE_TTL;
        n.expire();
        assert_eq!(n.len(), 0);
    }
}
