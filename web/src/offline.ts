// Safe offline receive: accept a token without the mint only if nobody but us can spend it
// (every proof P2PK-locked to this wallet's key, no refund/locktime escape hatch) and every proof
// carries a valid mint signature (DLEQ, NUT-12) against keys cached while online. Accepted tokens
// are queued and redeemed, signing with our key, as soon as the mint is reachable.
import {
  KeyChain,
  getDecodedToken,
  hasValidDleq,
  parseP2PKSecret,
  type KeyChainCache,
} from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** This browser's P2PK key (demo: kept in localStorage, never leaves the device). */
export function loadOrCreateKey(storeKey: string): { priv: string; pub: string } {
  let priv = localStorage.getItem(storeKey);
  if (!priv || !/^[0-9a-f]{64}$/.test(priv)) {
    priv = hex(secp256k1.utils.randomSecretKey());
    localStorage.setItem(storeKey, priv);
  }
  const pub = hex(secp256k1.getPublicKey(Uint8Array.from(priv.match(/../g)!.map((h) => parseInt(h, 16))), true));
  return { priv, pub };
}

export type OfflineVerdict = { ok: true; amount: number } | { ok: false; reason: string };

/** Pure, network-free checks; `cache` is the keychain saved while online. */
export function verifyOffline(token: string, cache: KeyChainCache | null, mintUrl: string, unit: string, ourPub: string): OfflineVerdict {
  if (!cache) return { ok: false, reason: "This device has never loaded the mint's keys while online, so it can't check signatures offline." };
  const keychain = KeyChain.fromCache(mintUrl, unit, cache);
  let decoded;
  try {
    decoded = getDecodedToken(token, keychain.getAllKeysetIds());
  } catch {
    return { ok: false, reason: 'The token uses mint keys this device has not seen; it can only be redeemed online.' };
  }
  let amount = 0;
  for (const [i, proof] of decoded.proofs.entries()) {
    if (!proof.dleq) {
      return {
        ok: false,
        reason:
          "This token has no DLEQ proofs (it was sent compact), so the mint's signatures can't be checked offline. " +
          'Redeem it when you are back online, or ask the sender for a token locked to your key (locked tokens always include them).',
      };
    }
    let secret;
    try {
      secret = parseP2PKSecret(proof.secret);
    } catch {
      return {
        ok: false,
        reason: 'This token is not locked to your key, so the sender (or anyone holding it) could still spend it before you redeem it. Only accept it online.',
      };
    }
    const [kind, data] = secret;
    if (kind !== 'P2PK' || String(data.data).toLowerCase() !== ourPub.toLowerCase()) {
      return { ok: false, reason: `Proof ${i} is locked to a different key, not this wallet's. Only accept it online (where it would be refused anyway).` };
    }
    const tags = (data.tags ?? []) as string[][];
    const risky = tags.find(([t, v]) => t === 'refund' || t === 'locktime' || t === 'pubkeys' || (t === 'n_sigs' && Number(v) > 1));
    if (risky) {
      return { ok: false, reason: `Proof ${i} has a "${risky[0]}" condition, so someone else could spend it. Only accept it online.` };
    }
    let keyset;
    try {
      keyset = keychain.getKeyset(proof.id);
    } catch {
      return { ok: false, reason: `Proof ${i} uses keyset ${proof.id}, not cached on this device.` };
    }
    if (!hasValidDleq(proof, keyset)) {
      return { ok: false, reason: `Proof ${i}'s mint signature is invalid (DLEQ check failed): the token is forged or damaged. Do not accept it.` };
    }
    amount += Number(proof.amount.toString());
  }
  return { ok: true, amount };
}

export type PendingReceipt = { token: string; amount: number; at: number };

export function loadPending(storeKey: string): PendingReceipt[] {
  try {
    return JSON.parse(localStorage.getItem(storeKey) ?? '[]') as PendingReceipt[];
  } catch {
    return [];
  }
}

export function savePending(storeKey: string, pending: PendingReceipt[]) {
  localStorage.setItem(storeKey, JSON.stringify(pending));
}
