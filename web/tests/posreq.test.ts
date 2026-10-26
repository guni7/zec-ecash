import './setup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { deriveKey, signHeaders } from '../src/wallet/posreq';

const SEED = '11'.repeat(32);

test('request keys: deterministic from the seed, one per index', () => {
  const a = deriveKey(SEED, 0);
  assert.deepEqual(deriveKey(SEED, 0), a, 'same seed and index, same key (a restored wallet re-derives it)');
  const keys = new Set(Array.from({ length: 50 }, (_, i) => deriveKey(SEED, i).pub));
  assert.equal(keys.size, 50, 'every index gives a different key');
  assert.notEqual(deriveKey('22'.repeat(32), 0).pub, a.pub, 'another seed, other keys');
  assert.match(a.pub, /^0[23][0-9a-f]{64}$/);
});

test('signed headers: BIP-340 over SHA-256 of the exact message the server checks', () => {
  const { priv, pub } = deriveKey(SEED, 3);
  const now = 1_800_000_000_000;
  const h = signHeaders(priv, 'collect', 'req1', now);
  assert.equal(h['x-pos-time'], '1800000000');
  const msg = sha256(utf8ToBytes('zec-ecash-pos-v1\ncollect\nreq1\n1800000000'));
  const xonly = hexToBytes(pub).slice(1);
  assert.ok(schnorr.verify(hexToBytes(h['x-pos-sig']), msg, xonly));
  const other = sha256(utf8ToBytes('zec-ecash-pos-v1\nack\nreq1\n1800000000'));
  assert.ok(!schnorr.verify(hexToBytes(h['x-pos-sig']), other, xonly), 'a collect signature is not an ack signature');
  assert.equal(signHeaders(priv, 'collect', 'req1', now, 90_000)['x-pos-time'], '1800000090', 'clock skew applied');
});
