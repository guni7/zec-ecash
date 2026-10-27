import './setup';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentRequest, decodePaymentRequest } from '@cashu/cashu-ts';
import { deriveKey, type PosRecord } from '../src/wallet/posreq';
import { pack, requestKey, unpack, type InvoiceDoc } from '../src/shop/link';
import { DAY, formatNumber, invoicesCsv, linesCsv, payments, rows, sales, stateOf, totals, type Invoice } from '../src/shop/model';
import { openShop } from '../src/shop/store';

const SEED = 'ab'.repeat(32);
const key = deriveKey(SEED, 0);
const creqFor = (pub: string, amount = 1000, id = 'req1', description?: string) =>
  new PaymentRequest([{ type: 'post' as never, target: 'https://shop.example/pos/payment' }], id, amount, 'zat', ['https://shop.example/mint'], description, true, { kind: 'P2PK', data: pub, tags: [] }).toEncodedCreqA();

test('totals: no tax, tax included, tax added; whole zats, half up', () => {
  const lines = [
    { desc: 'Coffee', qty: 2, unit: 1500 },
    { desc: 'Cake', qty: 1, unit: 2001 },
  ];
  assert.deepEqual(totals(lines), { subtotal: 5001, tax: 0, total: 5001 });
  assert.deepEqual(totals(lines, 10, true), { subtotal: 4546, tax: 455, total: 5001 }); // 5001 - 5001/1.1 = 454.6
  assert.deepEqual(totals(lines, 10, false), { subtotal: 5001, tax: 500, total: 5501 }); // 500.1
  assert.deepEqual(totals([{ desc: 'x', qty: 1, unit: 5 }], 10, false), { subtotal: 5, tax: 1, total: 6 }); // 0.5 rounds up
  assert.deepEqual(totals([]), { subtotal: 0, tax: 0, total: 0 });
});

test('numbering: INV-0001 style, prefix kept', () => {
  assert.equal(formatNumber('INV-', 1), 'INV-0001');
  assert.equal(formatNumber('A/', 12345), 'A/12345');
});

/** A fake wallet for the shop store: requests are created in memory. */
function fakeWallet(mintUrl: string) {
  localStorage.setItem(`zec-ecash-demo:seed:${mintUrl}`, SEED);
  const records: PosRecord[] = [];
  let index = 0;
  let fail = false;
  const core = { mintUrl, key: (n: string) => `zec-ecash-demo:${n}:${mintUrl}`, emit() {} } as never;
  const posreq = {
    records: () => records,
    async create(amount: number, opts: { expiresAt?: number; description?: string } = {}) {
      if (fail) throw new Error('Point of sale is offline.');
      const i = index++;
      const pub = deriveKey(SEED, i).pub;
      const rec: PosRecord = { id: `r${i}`, index: i, pubkey: pub, amount, created: Date.now(), request: creqFor(pub, amount, `r${i}`, opts.description), state: 'open', expiresAt: opts.expiresAt };
      records.push(rec);
      return rec;
    },
    markRefunded() {},
    async cancel() {},
  } as never;
  return { core, posreq, records, setFail: (v: boolean) => (fail = v) };
}

test('numbering: taken before use, never reused after a failed request, a delete or a wipe', async () => {
  const w = fakeWallet('https://numbering.example/mint');
  const shop = await openShop(w.core, w.posreq, {} as never);
  await shop.setProfile({ name: 'Bean', prefix: 'INV-', taxIncluded: true, counterExpiryMin: 15, sentExpiryDays: 7, autoReturnSec: 5 });
  const a = await shop.issue(await shop.saveDraft({ lines: [{ desc: 'x', qty: 1, unit: 100 }] }));
  assert.equal(a.number, 'INV-0001');
  // the request fails: the invoice keeps its number, which nobody else gets
  w.setFail(true);
  const b = await shop.saveDraft({ lines: [{ desc: 'y', qty: 1, unit: 200 }] });
  await assert.rejects(shop.issue(b), /offline/);
  assert.equal(shop.get(b.id)!.number, 'INV-0002');
  assert.equal(shop.get(b.id)!.issuedAt, undefined);
  w.setFail(false);
  assert.equal((await shop.issue(shop.get(b.id)!)).number, 'INV-0002');
  const draft = await shop.saveDraft({ lines: [{ desc: 'z', qty: 1, unit: 1 }] });
  await shop.deleteDraft(draft.id);
  await shop.wipe();
  const c = await shop.issue(await shop.saveDraft({ lines: [{ desc: 'z', qty: 1, unit: 300 }] }));
  assert.equal(c.number, 'INV-0003');
  // a backup with an older counter never moves it back
  const d = await shop.dump();
  await shop.restore({ ...d, seq: 1 });
  assert.equal(await shop.lastSeq(), 3);
  // the request carries only the number as its description
  assert.equal(decodePaymentRequest(c.creq!).description, 'INV-0003');
});

/** An issued invoice for 1,000 zats paid through request r1. */
const inv = (patch: Partial<Invoice> = {}): Invoice => ({
  id: 'i1',
  kind: 'sent',
  number: 'INV-0001',
  lines: [{ desc: 'Thing', qty: 1, unit: 1000 }],
  taxIncluded: true,
  createdAt: 0,
  issuedAt: 1000,
  expiresAt: 10_000,
  requests: ['r1'],
  refunds: [],
  history: [],
  ...patch,
});
const rec = (patch: Partial<PosRecord> = {}): PosRecord => ({ id: 'r1', index: 0, pubkey: key.pub, amount: 1000, created: 1000, state: 'open', ...patch });

test('states: draft, open, partial, paid, overpaid, expired, cancelled, refunded', () => {
  const st = (i: Invoice, r: PosRecord[], now = 5000) => stateOf(i, payments(i, r), now);
  assert.equal(st(inv({ issuedAt: undefined }), []), 'draft');
  assert.equal(st(inv(), [rec()]), 'open');
  assert.equal(st(inv(), [rec()], 20_000), 'expired');
  assert.equal(st(inv({ cancelledAt: 3000 }), [rec()]), 'cancelled');
  const partial = rec({ extras: [{ n: 1, kind: 'partial', received: 400, at: 2000, state: 'done' }] });
  assert.equal(st(inv(), [partial]), 'partial');
  assert.equal(st(inv({ acceptedShortAt: 3000 }), [partial]), 'paid');
  // a top-up through a second request for the rest
  const rest: PosRecord = { ...rec({ id: 'r2', amount: 600 }), state: 'done', received: 600, collected: 600, paidAt: 3000 };
  assert.equal(st(inv({ requests: ['r1', 'r2'] }), [partial, rest]), 'paid');
  const paid = rec({ state: 'done', received: 1000, collected: 1000, paidAt: 2000 });
  assert.equal(st(inv(), [paid]), 'paid');
  assert.equal(st(inv(), [paid], 99_000), 'paid'); // paid stays paid after the expiry
  const over = { ...paid, extras: [{ n: 1, kind: 'extra' as const, received: 1000, at: 2500, state: 'done' as const }] };
  assert.equal(st(inv(), [over]), 'overpaid');
  // refunding only the excess leaves it paid
  assert.equal(st(inv({ refunds: [{ at: 4000, amount: 1000, tokenId: 't', what: 'extra' }] }), [over]), 'paid');
  assert.equal(st(inv({ refunds: [{ at: 4000, amount: 1000, tokenId: 't', what: 'full' }] }), [paid]), 'refunded');
  assert.equal(st(inv({ refunds: [{ at: 4000, amount: 300, tokenId: 't', what: 'part' }] }), [paid]), 'part-refunded');
});

test('late payments: after expiry or cancel they don’t pay the invoice', () => {
  const late = rec({ state: 'done', received: 1000, collected: 1000, paidAt: 12_000 });
  const p = payments(inv(), [late]);
  assert.equal(p[0].late, true);
  assert.equal(stateOf(inv(), p, 13_000), 'expired');
  const afterCancel = payments(inv({ cancelledAt: 1500 }), [rec({ state: 'done', received: 1000, collected: 1000, paidAt: 2000 })]);
  assert.equal(afterCancel[0].late, true);
  // refunding a late payment doesn't make the invoice "refunded"
  assert.equal(stateOf(inv({ refunds: [{ at: 14_000, amount: 1000, tokenId: 't', what: 'late', late: true }] }), p, 15_000), 'expired');
});

test('links: signed with the request key; any change is caught', async () => {
  const creq = creqFor(key.pub);
  assert.equal(requestKey(creq), key.pub);
  const doc: InvoiceDoc = { v: 1, shop: { name: 'Bean & Leaf' }, number: 'INV-0001', kind: 'sent', customer: 'Ana', lines: [{ desc: 'Thing', qty: 1, unit: 1000 }], taxIncluded: true, totals: totals([{ desc: 'Thing', qty: 1, unit: 1000 }]), issuedAt: 1, creq };
  const data = await pack('invoice', doc, key.priv);
  assert.match(data, /^[A-Za-z0-9_-]+$/);
  const ok = await unpack<InvoiceDoc>('invoice', data);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.doc, doc);
  // signed by another key: shown with a warning
  const other = await pack('invoice', doc, deriveKey(SEED, 9).priv);
  assert.equal((await unpack('invoice', other)).valid, false);
  // a changed total under the same signature
  const forged = JSON.parse(new TextDecoder().decode(await new Response(new Blob([Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()));
  forged.d.totals.total = 1;
  const bytes = new Uint8Array(await new Response(new Blob([JSON.stringify(forged)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const reenc = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal((await unpack('invoice', reenc)).valid, false);
  await assert.rejects(unpack('invoice', 'not-a-link'), /damaged/);
  // a receipt is verified against the key it names
  const r = await pack('receipt', { v: 1, shop: { name: 'Bean' }, number: 'INV-0001', lines: [], taxIncluded: true, totals: { subtotal: 1, tax: 0, total: 1 }, paid: 1, paidAt: 2, request: 'r1', key: key.pub }, key.priv);
  assert.equal((await unpack('receipt', r)).valid, true);
});

test('CSV: one row per invoice and per line; quotes, commas and formulas are safe', () => {
  const r = rows([inv({ customer: { name: 'Ana, "the" buyer' }, note: '=HYPERLINK("x")', lines: [{ desc: 'Tea\nlarge', qty: 2, unit: 500 }] })], [rec({ state: 'done', received: 1000, collected: 1000, paidAt: 2000 })], 5000);
  const a = invoicesCsv(r);
  assert.match(a, /^number,kind,state,customer,/);
  assert.match(a, /"Ana, ""the"" buyer"/);
  assert.match(a, /"'=HYPERLINK\(""x""\)"/);
  assert.match(a, /,1000,1000,0,0,/); // total, paid, refunded, late
  const l = linesCsv(r);
  assert.equal(l.split('\r\n').length, 3);
  assert.match(l, /"Tea\nlarge",2,500,1000/);
});

test('dashboard: sales by day, average, open total, top items, counter vs sent', () => {
  const t0 = new Date(2026, 9, 1, 12).getTime();
  const all = rows(
    [
      inv({ id: 'a', number: 'INV-0001', kind: 'counter', issuedAt: t0, expiresAt: t0 + DAY * 9, requests: ['ra'], lines: [{ desc: 'Coffee', qty: 2, unit: 1500, itemId: 'c' }] }),
      inv({ id: 'b', number: 'INV-0002', issuedAt: t0, expiresAt: t0 + DAY * 9, requests: ['rb'], lines: [{ desc: 'Cake', qty: 1, unit: 4000, itemId: 'k' }] }),
      inv({ id: 'c', number: 'INV-0003', issuedAt: t0, expiresAt: t0 + DAY * 9, requests: ['rc'], lines: [{ desc: 'Coffee', qty: 1, unit: 1500, itemId: 'c' }] }),
    ],
    [
      { ...rec({ id: 'ra', amount: 3000 }), state: 'done', received: 3000, collected: 3000, paidAt: t0 + 1000 },
      { ...rec({ id: 'rb', amount: 4000 }), state: 'done', received: 4000, collected: 4000, paidAt: t0 + DAY + 1000 },
      rec({ id: 'rc', amount: 1500 }),
    ],
    t0 + DAY * 2,
  );
  const s = sales(all, { from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 9, 4).getTime() });
  assert.equal(s.total, 7000);
  assert.equal(s.count, 2);
  assert.equal(s.average, 3500);
  assert.equal(s.openTotal, 1500);
  assert.deepEqual(s.days.map((d) => d.total), [3000, 4000, 0]);
  assert.deepEqual(s.topItems.map((i) => [i.name, i.revenue, i.qty]), [['Cake', 4000, 1], ['Coffee', 3000, 2]]);
  assert.equal(s.counter, 3000);
  assert.equal(s.sent, 4000);
});
