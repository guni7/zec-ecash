import './setup';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/ui/classify';
import { money, parseAmount, plain, plainOrNull, setZatsFirst } from '../src/ui/words';

test('scan: each kind of code goes to its place', () => {
  assert.equal(classify('cashuBo2FteCJodHRwczovL2V4YW1wbGU').kind, 'token');
  assert.equal(classify('  cashu:cashuBo2Ft\n').text, 'cashuBo2Ft');
  assert.equal(classify('creqApWF0YWJjZGVm').kind, 'request');
  assert.equal(classify('zcash:u1abc?amount=0.1').kind, 'address');
  assert.equal(classify(`uregtest1${'q'.repeat(60)}`).kind, 'address');
  assert.equal(classify(`u1${'x'.repeat(100)}`).kind, 'address');
  assert.equal(classify('t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs').kind, 'address');
  const pub = `02${'AB'.repeat(32)}`;
  assert.deepEqual(classify(pub), { kind: 'pubkey', text: pub.toLowerCase() });
  for (const x of ['hello', 'https://example.com', `04${'ab'.repeat(32)}`, 'u1short', '']) assert.equal(classify(x).kind, 'unknown', x);
});

test('amounts: ZEC with up to 8 decimals, comma as decimal point, zats as whole numbers', () => {
  assert.equal(parseAmount('0.0006', 'ZEC'), 60_000);
  assert.equal(parseAmount('0,0006', 'ZEC'), 60_000);
  assert.equal(parseAmount('.5', 'ZEC'), 50_000_000);
  assert.equal(parseAmount('1', 'ZEC'), 100_000_000);
  assert.equal(parseAmount('0.00000001', 'ZEC'), 1);
  assert.equal(parseAmount(' ', 'ZEC'), null);
  assert.throws(() => parseAmount('0.000000001', 'ZEC'), /8 decimal places/);
  assert.throws(() => parseAmount('0', 'ZEC'), /above zero/);
  assert.throws(() => parseAmount('1.2.3', 'ZEC'), /like 0.001/);
  assert.equal(parseAmount('60,000', 'zats'), 60_000);
  assert.throws(() => parseAmount('1.5', 'zats'), /whole number/);
});

test('amounts: zats first with ZEC underneath (the default), or the reverse', () => {
  assert.deepEqual(money(60_000), { main: '60,000 zats', sub: '0.0006 ZEC' }, 'zats first by default');
  setZatsFirst(false);
  assert.deepEqual(money(60_000), { main: '0.0006 ZEC', sub: '60,000 zats' });
  assert.deepEqual(money(1), { main: '0.00000001 ZEC', sub: '1 zat' });
  setZatsFirst(true);
  assert.deepEqual(money(60_000), { main: '60,000 zats', sub: '0.0006 ZEC' });
  setZatsFirst(false);
});

test('plain words: wallet errors say what happened and what to do, without jargon', () => {
  setZatsFirst(false); // the sentences below are written with ZEC amounts
  const cases: Array<[string, RegExp]> = [
    ['Already spent: this token was redeemed before.', /already used/],
    ['Mint unreachable at https://x/mint. Is the devnet running?', /Can’t reach the service/],
    ['Not enough ecash: balance is 5 zat.', /don’t have enough money/],
    ['Wrong mint: this token is from https://other.example/mint; this wallet uses https://x/mint.', /another service \(other\.example\)/],
    ['Offline, not accepted: This token is not locked to your key, so the sender could spend it.', /offline.*show them your code/],
    ["The mint's minimum deposit is 1000 zat.", /minimum is 0\.00001 ZEC/],
    ['Deposit confirmed: minted 60000 zat of ecash.', /Added 0\.0006 ZEC/],
    ['Withdrawal paid: 12000 zat sent in abc; fee 1 zat, change 2 zat.', /Cashed out 0\.00012 ZEC/],
    ['Partial payment received: 250 of 900 zat. The request is still unpaid; you can refund it.', /Partial payment: 0\.0000025 ZEC of 0\.000009 ZEC/],
    ['The mint refused: reserve cap reached; 1 ecash token', /^The service said no: reserve cap reached; 1 money code$/],
  ];
  for (const [msg, want] of cases) {
    const out = plain(msg);
    assert.match(out, want, msg);
    assert.doesNotMatch(out, /\b(mint|token|ecash|proof|melt|quote|DLEQ|P2PK|NUT)\b/i, out);
  }
  assert.equal(plainOrNull('Deposit quote created: pay exactly 0.0006 ZEC to the address shown.'), null);
});

test('Zcash addresses in QR codes: uppercase (ZIP-316 alphanumeric mode) reads as the address', async () => {
  const { normalizePaymentText, parsePaymentUri } = await import('../src/wallet/onchain');
  const ua = 'u1qf5vq2p7chw0x8mz3ldfz4x4rtnvqx9c3hzgk0q5kvn6xw8k8a5d4wq0yq4ycz3l7e3d0y6cn3e8f6v4mqcs9zt';
  assert.deepEqual(classify(ua.toUpperCase()), { kind: 'address', text: ua }, 'the centre Scan button takes it');
  assert.deepEqual(classify(ua), { kind: 'address', text: ua });
  assert.equal(parsePaymentUri(ua.toUpperCase()).address, ua, 'Cash out sends the lowercase address');
  const link = parsePaymentUri(`ZCASH:${ua.toUpperCase()}?AMOUNT=0.0012`);
  assert.equal(link.address, ua);
  assert.equal(link.amount, 120_000, 'parameter names in uppercase too');
  assert.equal(classify(`ZCASH:${ua.toUpperCase()}?AMOUNT=0.0012`).kind, 'address');
  assert.equal(parsePaymentUri(`zcash:?address=${ua.toUpperCase()}`).address, ua);
  // what Cash out shows after a scan
  assert.equal(normalizePaymentText(`ZCASH:${ua.toUpperCase()}?AMOUNT=0.0012&MEMO=SGVsbG8`), `zcash:${ua}?amount=0.0012&memo=SGVsbG8`, 'memo value kept as is');
  assert.equal(normalizePaymentText(` ${ua.toUpperCase()} `), ua);
  // mixed case is not a valid address: left alone (the service refuses it)
  const mixed = `U1${ua.slice(2)}`;
  assert.equal(parsePaymentUri(mixed).address, mixed);
  assert.equal(classify(mixed).kind, 'unknown');
  // transparent addresses are case-sensitive base58: never changed
  const t = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU';
  assert.equal(parsePaymentUri(t).address, t);
  assert.deepEqual(classify(t), { kind: 'address', text: t });
});
