//! FROST (RedPallas) helpers shared by the coordinator and guardians.
pub use reddsa::frost::redpallas;

#[cfg(test)]
mod tests {
    use super::redpallas as frost;
    use std::collections::BTreeMap;

    /// Phase 0 spike: 2-of-3 trusted-dealer FROST signature over a dummy message.
    #[test]
    fn two_of_three_signs() {
        let mut rng = rand::thread_rng();
        let (shares, pubkeys) = frost::keys::generate_with_dealer(
            3, 2, frost::keys::IdentifierList::Default, &mut rng,
        ).unwrap();
        let key_packages: BTreeMap<_, _> = shares
            .into_iter()
            .map(|(id, s)| (id, frost::keys::KeyPackage::try_from(s).unwrap()))
            .collect();
        let signers: Vec<_> = key_packages.keys().take(2).cloned().collect();

        let mut nonces = BTreeMap::new();
        let mut commitments = BTreeMap::new();
        for id in &signers {
            let (n, c) = frost::round1::commit(key_packages[id].signing_share(), &mut rng);
            nonces.insert(*id, n);
            commitments.insert(*id, c);
        }
        let msg = b"zec-ecash withdrawal sighash (dummy)";
        let package = frost::SigningPackage::new(commitments, msg);
        let mut shares_out = BTreeMap::new();
        for id in &signers {
            let s = frost::round2::sign(&package, &nonces[id], &key_packages[id]).unwrap();
            shares_out.insert(*id, s);
        }
        let sig = frost::aggregate(&package, &shares_out, &pubkeys).unwrap();
        assert!(pubkeys.verifying_key().verify(msg, &sig).is_ok());
    }
}
