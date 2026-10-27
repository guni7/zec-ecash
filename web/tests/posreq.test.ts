import './setup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { CANCELLED, EXPIRED, checkOpen, createPosRequests, deliver, deriveKey, signHeaders, type RequestInfo } from '../src/wallet/posreq';
import { payments, stateOf, type Invoice } from '../src/shop/model';

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

// ---- against a fake payment service (fetch replaced) ----

(globalThis as Record<string, unknown>).location = { origin: 'https://shop.test' };
type Call = { url: string; method: string; headers: Record<string, string> };
function fakeFetch(answer: (url: URL, init: RequestInit) => { status?: number; body: unknown } | 'down') {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> });
    const a = answer(url, init);
    if (a === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const fakeCore = (mint: string) =>
  ({ mintUrl: mint, unit: 'zat', key: (n: string) => `t:${n}:${mint}`, emit() {}, say() {}, connect: async () => ({}), isNetworkError: () => false, explain: (e: unknown) => String(e) }) as never;

test('create: expiry (unix s) and description go to the server', async () => {
  const calls = fakeFetch(() => ({ body: { id: 'q1', request: 'creqAx' } }));
  const pr = createPosRequests(fakeCore('https://m1.test'));
  const at = Date.UTC(2026, 9, 27, 12, 0, 0, 500);
  const rec = await pr.create(1500, { expiresAt: at, description: 'INV-0007' });
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get('expires_at'), String(Math.floor(at / 1000)));
  assert.equal(q.get('description'), 'INV-0007');
  assert.equal(q.get('amount'), '1500');
  assert.equal(rec.expiresAt, at);
  await pr.create(10);
  assert.equal(new URL(calls[1].url).searchParams.has('expires_at'), false, 'no expiry: none sent (never expires)');
});

test('cancel: signed "cancel" by the request key; the server’s time is kept', async () => {
  const pr = createPosRequests(fakeCore('https://m2.test'));
  fakeFetch(() => ({ body: { id: 'q2', request: 'creqAx' } }));
  const rec = await pr.create(100);
  const calls = fakeFetch(() => ({ body: { ok: true, cancelled_at: 1_800_000_123 } }));
  await pr.cancel('q2');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/pos\/requests\/q2\/cancel$/);
  const t = calls[0].headers['x-pos-time'];
  const msg = sha256(utf8ToBytes(`zec-ecash-pos-v1\ncancel\nq2\n${t}`));
  assert.ok(schnorr.verify(hexToBytes(calls[0].headers['x-pos-sig']), msg, hexToBytes(rec.pubkey).slice(1)), 'signed by the request’s own key');
  assert.equal(pr.records().find((r) => r.id === 'q2')!.cancelledAt, 1_800_000_123_000);
});

test('a phone offline during an on-time payment doesn’t mark it late (server receive times)', async () => {
  const pr = createPosRequests(fakeCore('https://m3.test'));
  const now = Date.now();
  const expiresAt = now - 60_000; // the invoice expired a minute ago…
  const paidAt = Math.floor((now - 600_000) / 1000); // …but the server got the payment ten minutes ago
  fakeFetch(() => ({ body: { id: 'q3', request: 'creqAx' } }));
  await pr.create(1000, { expiresAt });
  // the phone comes back online now and collects
  fakeFetch((u) =>
    /\/requests\/q3\/payment$/.test(u.pathname)
      ? { body: { state: 'PAID', received: 1000, collected: true, paid_at: paidAt, expires_at: Math.floor(expiresAt / 1000), extras: [{ n: 1, kind: 'extra', received: 50, collected: true, paid_at: paidAt + 5 }] } }
      : { body: {} },
  );
  await pr.collectAll();
  const rec = pr.records().find((r) => r.id === 'q3')!;
  assert.equal(rec.paidAt, paidAt * 1000, 'the server’s time, not when the phone saw it');
  assert.equal(rec.extras![0].at, (paidAt + 5) * 1000);
  const inv: Invoice = { id: 'i', kind: 'counter', number: 'INV-0001', lines: [{ desc: 'x', qty: 1, unit: 1000 }], taxIncluded: true, createdAt: 0, issuedAt: now - 900_000, expiresAt, requests: ['q3'], refunds: [], history: [] };
  const pays = payments(inv, pr.records());
  assert.deepEqual(pays.map((p) => p.late), [false, false], 'on time');
  assert.equal(stateOf(inv, pays), 'overpaid');
});

test('a payment the server refused as late (kind "late") never pays the invoice', () => {
  const inv: Invoice = { id: 'i', kind: 'sent', number: 'INV-0002', lines: [{ desc: 'x', qty: 1, unit: 1000 }], taxIncluded: true, createdAt: 0, issuedAt: 1, expiresAt: 10_000, requests: ['r'], refunds: [], history: [] };
  const recs = [{ id: 'r', index: 0, pubkey: '02', amount: 1000, created: 1, state: 'open' as const, cancelledAt: 3000, extras: [{ n: 1, kind: 'late' as const, received: 1000, at: 4000, state: 'done' as const }] }];
  const pays = payments(inv, recs);
  assert.equal(pays[0].late, true);
  assert.equal(stateOf({ ...inv, cancelledAt: 3000 }, pays, 5000), 'cancelled');
});

const info: RequestInfo = { id: 'q9', amount: 10, target: 'https://shop.test/pos/payment', lockTo: '02'.padEnd(66, 'a') };

test('payer: an expired or cancelled request is refused before anything is paid', async () => {
  fakeFetch(() => ({ body: { expired: true, cancelled: false, expires_at: 100, now: 200 } }));
  await assert.rejects(checkOpen(info), (e: Error) => e.message === EXPIRED && /expired/.test(e.message));
  fakeFetch(() => ({ body: { expired: false, cancelled: true, now: 200 } }));
  await assert.rejects(checkOpen(info), (e: Error) => e.message === CANCELLED && /cancelled/.test(e.message));
  // about to expire (server clock): don't start
  fakeFetch(() => ({ body: { expired: false, cancelled: false, expires_at: 210, now: 200 } }));
  await assert.rejects(checkOpen(info), (e: Error) => e.message === EXPIRED);
  // open, never expiring, unreachable, or another kind of server: go on
  fakeFetch(() => ({ body: { expired: false, cancelled: false, expires_at: null, now: 200 } }));
  await checkOpen(info);
  fakeFetch(() => 'down');
  await checkOpen(info);
  const calls = fakeFetch(() => ({ body: {} }));
  await checkOpen({ ...info, target: 'https://other.example/pay' });
  assert.equal(calls.length, 0, 'not our transport: not asked');
});

test('payer: a refusal on delivery says expired / cancelled in plain words', async () => {
  fakeFetch(() => ({ status: 410, body: { error: 'expired: this payment request has expired; ask the shop for a new one', kept: true } }));
  const [ok, msg] = await deliver(info, 'https://mint', 'zat', []);
  assert.equal(ok, false);
  assert.match(msg, /^This payment request expired as you paid/);
  assert.match(msg, /can refund it/);
  fakeFetch(() => ({ status: 410, body: { error: 'cancelled: the shop cancelled this payment request; ask for a new one' } }));
  assert.match((await deliver(info, 'https://mint', 'zat', []))[1], /^The shop cancelled this payment request/);
});
