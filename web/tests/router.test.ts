import './setup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeed } from '../src/wallet/activity';
import { parsePaymentUri, zip321, zatToZec } from '../src/wallet/onchain';
import { filledSegments } from '../src/wallet/status';
import { PATHS, REDIRECTS, parse } from '../src/ui/router';

test('routes: every page parses to itself', () => {
  for (const p of PATHS) assert.equal(parse(`#${p}`).path, p);
});

test('routes: empty, bare and trailing-slash hashes', () => {
  assert.equal(parse('').path, '/');
  assert.equal(parse('#').path, '/');
  assert.equal(parse('#/').path, '/');
  assert.equal(parse('#/send/').path, '/send');
  assert.equal(parse('#send').path, '/send');
});

test('routes: old pages redirect, keeping their parameters', () => {
  const r = parse('#/request?r=abc');
  assert.equal(r.path, '/receive');
  assert.equal(r.moved, true);
  assert.equal(r.params.get('r'), 'abc');
  for (const to of Object.values(REDIRECTS)) assert.ok((PATHS as readonly string[]).includes(to));
  assert.equal(parse('#/receive').moved, undefined);
});

test('routes: unknown pages go home', () => {
  assert.equal(parse('#/nope').path, '/');
  assert.equal(parse('#/../etc').path, '/');
});

test('routes: query parameters', () => {
  const r = parse('#/deposit?q=01a1-abc&x=1');
  assert.equal(r.path, '/deposit');
  assert.equal(r.params.get('q'), '01a1-abc');
  assert.equal(parse('#/send?t=a%2Bb').params.get('t'), 'a+b');
});

test('ZIP-321: amounts in ZEC, round trip', () => {
  assert.equal(zatToZec(60000), '0.0006');
  assert.equal(zatToZec(100_000_000), '1');
  assert.equal(zatToZec(123_456_789), '1.23456789');
  assert.equal(zip321('u1abc', 12000), 'zcash:u1abc?amount=0.00012');
  assert.deepEqual(parsePaymentUri('zcash:u1abc?amount=0.00012'), { address: 'u1abc', amount: 12000, note: undefined });
  assert.equal(parsePaymentUri('  u1plain ').address, 'u1plain');
  assert.equal(parsePaymentUri('zcash:?address=u1x&amount=1').amount, 100_000_000);
  assert.throws(() => parsePaymentUri('zcash:u1a?address.1=u1b&amount.1=1'), /several payments/);
  assert.throws(() => parsePaymentUri('zcash:u1a?amount=1.123456789'), /not a ZEC amount/);
});

test('confirmation bar: 10 segments', () => {
  assert.equal(filledSegments(0, 10), 0);
  assert.equal(filledSegments(3, 10), 3);
  assert.equal(filledSegments(12, 10), 10);
  assert.equal(filledSegments(1, 1), 10);
  assert.equal(filledSegments(1, 3), 3);
});

test('activity feed: newest first, pending flagged, links to resume', () => {
  const feed = buildFeed({
    deposits: [{ quote: 'd1', amount: 5000, address: 'u', expiry: null, created: 3000, state: 'unpaid' }],
    withdrawals: [{ quote: 'w1', amount: 12000, feeReserve: 10000, address: 'u', created: 2000, state: 'paid', inputs: [], outputs: [], fee: 10000, change: 2576 }],
    sent: [{ id: 's1', token: 'cashuB', amount: 300, at: 4000, state: 'pending', compact: true, proofs: [] }],
    received: [{ id: 'r1', amount: 70, at: 1000, how: 'offline' }],
  });
  assert.deepEqual(
    feed.map((f) => [f.kind, f.amount, f.pending, f.href]),
    [
      ['send', -300, true, '/send?t=s1'],
      ['deposit', 5000, true, '/deposit?q=d1'],
      ['withdraw', -22000, false, '/withdraw?q=w1'],
      ['receive', 70, false, '/receive'],
    ],
  );
  assert.deepEqual(
    feed.map((f) => f.title),
    ['Sent', 'Add money', 'Cash out', 'Received'],
  );
});

test('activity feed: payment requests link to Receive; partial payments carry the amount asked', () => {
  const feed = buildFeed({
    deposits: [],
    withdrawals: [],
    sent: [],
    received: [],
    requests: [
      { id: 'q1', index: 0, pubkey: '02', amount: 900, created: 1000, state: 'open', extras: [{ n: 1, kind: 'partial', received: 250, at: 2000, state: 'done' }] },
    ],
  });
  assert.deepEqual(
    feed.map((f) => [f.title, f.amount, f.href, f.of]),
    [
      ['Partial payment received', 250, '/receive?r=q1', 900],
      ['Asked for payment', 900, '/receive?r=q1', undefined],
    ],
  );
  assert.ok(!feed.some((f) => /\b(mint|token|ecash|zat)\b/i.test(`${f.title} ${f.status}`)));
});
