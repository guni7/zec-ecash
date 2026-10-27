// Devnet browser test of shop mode: a shop (desktop, 1280 px) and customers (phones) in headless
// Chrome, paying by scanning the shop's screen (a fake camera fed its QR code) and with
// zec-ecash-cli. Covers: setting up a shop; a catalogue sale paid at the counter; a partial
// payment then a top-up; an overpayment refunded; a sent invoice opened in a second browser and
// paid there; expiry and cancel enforced by the payment service (refused for the CLI and the web
// wallet; a refused payment kept and refunded; an on-time payment seen late by an offline phone);
// a PDF of each kind (valid, with the number and total); a CSV export; the dashboard's totals
// against the invoices; and screenshots at 1280 and 360 px.
//
//   scripts/devnet-up.sh; cargo build --release -p zec-ecash-cli
//   cd web && npm run e2e:shop          # OUT=<dir> for the screenshots, PDFs and CSVs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { launch } from './cdp.mjs';
import { J, fakeCamera, getStarted, nav, pointCamera, sleep, tap, text, type } from './ui.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const URL_ = `https://${HOST}:5173/`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-shop-'));
const DL = join(OUT, 'downloads');
mkdirSync(DL, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ZEC_MINT_CA: 'web/certs/rootCA.pem' } });
const cli = (...args) => sh('./target/release/zec-ecash-cli', args);
/** The CLI's output even when it fails (a refused payment). */
const cliTry = (...args) => {
  try {
    return cli(...args);
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};
let lastMine = 0;
const mine = async () => {
  if (Date.now() - lastMine < 2500) return;
  lastMine = Date.now();
  sh('devnet/mine.sh', ['1']);
};
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  log(`ok: ${what}`);
};
const shots = [];
const shot = async (p, name, full = false) => {
  await sleep(300);
  await p.screenshot(join(OUT, `${name}.png`), full);
  shots.push(name);
};
const result = (re) => `${re}.test(document.querySelector('.result-title')?.textContent ?? '')`;
const zats = (s) => Number(String(s).replace(/[^0-9]/g, ''));
/** The state badge of invoice `number` in the Invoices list. */
const stateOf = async (p, number) => {
  await nav(p, '/dashboard');
  await nav(p, '/invoices');
  return p.eval(`(() => { const r = [...document.querySelectorAll('.inv-row')].find((r) => r.textContent.includes(${J(number)})); return r?.querySelector('[data-state]')?.dataset.state ?? ''; })()`);
};
const openInvoice = async (p, number) => {
  await nav(p, '/dashboard');
  await nav(p, '/invoices');
  await p.eval(`[...document.querySelectorAll('.inv-row a')].find((a) => a.textContent === ${J(number)}).click()`);
  await p.waitFor(`/#\\/invoices\\?id=/.test(location.hash) && document.querySelector('.inv-sum')`, 10000);
};

/** Files the page saved, after `run`: waits for new ones in DL. */
async function downloads(run, n = 1, timeout = 30000) {
  const before = new Set(readdirSync(DL));
  await run();
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const fresh = readdirSync(DL).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length >= n) {
      await sleep(400);
      return fresh.map((f) => join(DL, f));
    }
    await sleep(250);
  }
  throw new Error('no download');
}

/** All text drawn in a PDF (pdf-lib writes standard-font text as hex strings). */
async function pdfText(file) {
  const bytes = readFileSync(file);
  const doc = await PDFDocument.load(bytes); // throws if it isn't a valid PDF
  const raw = bytes.toString('latin1');
  let all = '';
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let s = Buffer.from(m[1], 'latin1');
    try {
      s = inflateSync(s);
    } catch {
      /* not compressed */
    }
    const t = s.toString('latin1');
    all += [...t.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((x) => Buffer.from(x[1], 'hex').toString('latin1')).join(' ');
    all += [...t.matchAll(/\(([^)]*)\)\s*Tj/g)].map((x) => x[1]).join(' ');
  }
  return { pages: doc.getPageCount(), size: doc.getPage(0).getSize(), text: all };
}

/** Page 1 of a PDF as a PNG (macOS sips), for the screenshots. */
function pdfShot(file, name) {
  const png = join(OUT, `${name}.png`);
  execFileSync('sips', ['-s', 'format', 'png', '-Z', '1400', file, '--out', png], { stdio: 'ignore' });
  shots.push(name);
}

const userAddr = sh('./target/debug/devwallet', ['address']).match(/uregtest1[a-z0-9]+/)[0];
const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9365));
try {
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  b.setDevice('desktop');
  const A = await b.open(`${URL_}#/`, undefined, 'shop');
  b.setDevice('phone');
  const B = await b.open(`${URL_}#/`, await b.newContext(), 'customer');
  for (const p of [A, B]) await fakeCamera(p);
  for (const p of [A, B]) await getStarted(p);
  for (const p of [A, B]) await p.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);

  // ---------- the customer adds money (regtest coins) ----------
  await nav(B, '/deposit');
  await type(B, null, '80000');
  await tap(B, { text: /^Get address$/ });
  await B.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
  sh('./target/debug/devwallet', ['send', await B.eval(`document.querySelector('.pay .chip').title`), '80000']);
  log('the customer pays 80,000 zats in from the devnet user wallet; mining');
  await B.waitFor(result(/Added/), 240000, mine);
  // the CLI (paying in some steps below) gets 15,000 zats from the customer, so the run needs nothing else
  await nav(B, '/send');
  await tap(B, { text: /^Show a code$/ });
  await type(B, null, '15000');
  await tap(B, { text: /^Show code$/ });
  await B.waitFor(`document.querySelector('.qr-card canvas') && document.querySelector('.details textarea')`, 15000);
  check(/received 15000/.test(cli('receive', await B.eval(`document.querySelector('.details textarea').value`))), 'the CLI wallet takes 15,000 zats from the customer for the steps it pays');

  // ---------- set up the shop ----------
  await nav(A, '/settings');
  await tap(A, { text: /Shop mode/, sel: 'label.toggle' });
  await A.waitFor(`location.hash === '#/shop?setup=1' && /Set up your shop/.test(document.querySelector('.page-title')?.textContent ?? '')`, 10000);
  const logo = join(OUT, 'logo.png');
  writeFileSync(logo, Buffer.from(await A.eval(`(() => { const c = document.createElement('canvas'); c.width = c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#f4b728'; g.beginPath(); g.arc(60, 60, 56, 0, 7); g.fill(); g.fillStyle = '#15110a'; g.font = 'bold 52px sans-serif'; g.textAlign = 'center'; g.fillText('B&L', 60, 78); return c.toDataURL('image/png').split(',')[1]; })()`), 'base64'));
  const { root } = await A.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await A.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#logo-file' });
  await A.send('DOM.setFileInputFiles', { nodeId, files: [logo] });
  await A.waitFor(`!document.querySelector('.logo-preview').hidden`, 5000);
  const fill = async (label, v) => A.eval(`(() => { const l = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith(${J(label)})); const e = document.getElementById(l.htmlFor); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill('Shop name', 'Bean & Leaf');
  await fill('Address', '12 Harbour Street, Lisbon');
  await fill('Tax/VAT number', 'PT 501 234 567');
  await fill('Email or phone', 'hello@beanandleaf.example');
  await fill('Tax rate', '10');
  await fill('Footer note', 'Thank you! Come back soon.');
  await shot(A, 'setup-1280', true);
  await tap(A, { text: /^Save and open the shop$/ });
  await A.waitFor(`location.hash === '#/charge' && /Bean & Leaf/.test(document.querySelector('.modebar').textContent)`, 10000);
  check((await A.eval(`[...document.querySelectorAll('.tabbar a, .side-nav a')].slice(-5).map((a) => a.textContent).join(',')`)) === 'Charge,Invoices,Dashboard,Wallet,Settings', 'shop mode: Charge · Invoices · Dashboard · Wallet · Settings, and the "Personal mode" strip');
  // the catalogue
  await nav(A, '/shop');
  for (const [n, pr, c] of [['Flat white', '1500', 'Drinks'], ['Green tea', '1200', 'Drinks'], ['Almond cake', '4000', 'Food'], ['Old scone', '900', 'Food']]) {
    await A.eval(`(() => { const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set('[aria-label="Item name"]', ${J(n)}); set('[aria-label="Item price in zats"]', ${J(pr)}); set('[aria-label="Item category"]', ${J(c)}); })()`);
    await tap(A, { text: /^Add item$/ });
    await A.waitFor(`document.querySelector('.list').textContent.includes(${J(n)})`, 5000);
  }
  await A.eval(`[...document.querySelectorAll('.item-row')].find((r) => r.textContent.includes('Old scone')).querySelector('button:last-child').click()`);
  await A.waitFor(`!document.querySelector('.list').textContent.includes('Old scone')`, 5000);
  check(true, 'catalogue: 4 items added, one archived');

  // ---------- 1. a catalogue sale at the counter ----------
  await nav(A, '/charge');
  await A.waitFor(`document.querySelectorAll('.item-btn').length === 3`, 10000);
  await tap(A, { text: /^Flat white/, sel: '.item-btn' });
  await tap(A, { text: /^Flat white/, sel: '.item-btn' });
  await tap(A, { text: /^Almond cake/, sel: '.item-btn' });
  const t1 = await text(A, '.cart');
  check(/7,000 zats/.test(t1) && /Tax 10% \(included\)/.test(t1) && /636 zats/.test(t1), `cart: 2 × 1,500 + 4,000 = 7,000 zats, tax included 636 zats`);
  await shot(A, 'charge-1280');
  await tap(A, { text: /^Charge 7,000 zats$/ });
  await A.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
  check(/Scan with your wallet to pay/.test(await text(A, '.customer')) && /Bean & Leaf/.test(await text(A, '.customer')), 'customer screen: shop, total, QR code, "Scan with your wallet to pay", countdown');
  await shot(A, 'customer-1280');
  await pointCamera(B, { from: A });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`/Pay this code/.test(document.querySelector('main').textContent)`, 15000);
  check(/INV-0001/.test(await text(B)), 'the customer’s wallet shows the invoice number (the request’s only description)');
  await tap(B, { text: /^Pay 7,000 zats$/ });
  await B.waitFor(result(/Paid/), 20000);
  await A.waitFor(`/Paid ✓/.test(document.querySelector('.customer')?.textContent ?? '') && document.querySelector('.cust-receipt canvas')`, 30000);
  await shot(A, 'paid-1280');
  // the receipt QR: the customer scans it and keeps it
  await pointCamera(B, { from: A });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`location.hash.startsWith('#/receipt/') && /Amount paid/.test(document.querySelector('main').textContent)`, 20000);
  check(!(await B.eval(`!!document.querySelector('.sig-warn')`)) && /INV-0001/.test(await text(B)), 'the receipt QR opens a signed receipt in the customer’s wallet');
  await tap(B, { text: /^Save to my Activity$/ });
  await nav(B, '/activity');
  check(/Receipt INV-0001/.test(await text(B)) && /Paid INV-0001/.test(await text(B)), 'customer Activity: "Paid INV-0001" and the saved receipt');
  await A.waitFor(`location.hash === '#/charge'`, 15000);
  log('ok: the counter went back to a new sale by itself');
  check((await stateOf(A, 'INV-0001')) === 'paid', 'INV-0001 paid');

  // ---------- 2. a partial payment, then the rest ----------
  await nav(A, '/charge');
  for (const k of ['5', '0', '0', '0']) await tap(A, { text: new RegExp(`^${k}$`), sel: '.key' });
  await A.eval(`(() => { const e = document.querySelector('[aria-label="Note for this amount"]'); e.value = 'Catering deposit'; })()`);
  await tap(A, { text: /^Add amount$/ });
  await tap(A, { text: /^Charge 5,000 zats$/ });
  await A.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
  const creq2 = await A.eval(`(async () => { const recs = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes(':pos-requests:')))); return recs[0].request; })()`);
  log('cli:', cli('pay', creq2, '--amount', '2000').trim().split('\n').pop().slice(0, 100));
  await A.waitFor(`/2,000 zats of 5,000 zats/.test(document.querySelector('.customer')?.textContent ?? '')`, 30000);
  check(/Wait for the rest/.test(await text(A, '.customer')) && /Accept as is/.test(await text(A, '.customer')), 'partial: "Received 2,000 zats of 5,000 zats", wait for the rest / accept as is / refund');
  await shot(A, 'partial-1280');
  await tap(A, { text: /^Wait for the rest/ });
  await A.waitFor(`/Scan to pay the rest: 3,000 zats/.test(document.querySelector('.customer')?.textContent ?? '')`, 15000);
  await pointCamera(B, { from: A });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await tap(B, { text: /^Pay 3,000 zats$/ });
  await B.waitFor(result(/Paid/), 20000);
  await A.waitFor(`/Paid ✓/.test(document.querySelector('.customer')?.textContent ?? '')`, 30000);
  check((await stateOf(A, 'INV-0002')) === 'paid', 'INV-0002: 2,000 then the rest (3,000) → paid');

  // ---------- 3. an overpayment, refunded ----------
  await nav(A, '/charge');
  await tap(A, { text: /^Green tea/, sel: '.item-btn' });
  await tap(A, { text: /^Charge 1,200 zats$/ });
  await A.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
  const creq3 = await A.eval(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes(':pos-requests:'))))[0].request`);
  cli('pay', creq3);
  await A.waitFor(`/Paid ✓/.test(document.querySelector('.customer')?.textContent ?? '')`, 30000);
  log('cli (paying again, by mistake):', cli('pay', creq3).trim().split('\n').pop().slice(0, 90));
  await openInvoice(A, 'INV-0003');
  await A.waitFor(`document.querySelector('.head-badge [data-state="overpaid"]') && [...document.querySelectorAll('.pay-row')].some((r) => /Extra payment/.test(r.textContent) && r.querySelector('.btn.danger-outline'))`, 40000);
  check(true, 'INV-0003 overpaid: the second payment shows as an extra payment with Refund');
  await A.eval(`(() => { const r = [...document.querySelectorAll('.pay-row')].find((r) => /Extra payment/.test(r.textContent)); r.querySelector('.btn.danger-outline').click(); })()`);
  await tap(A, { text: /^Make the refund code$/ });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const refund = await A.eval(`document.querySelector('.details textarea').value`);
  check(/received 1200/.test(cli('receive', refund)), 'the extra 1,200 zats refunded as a code, taken back by the payer');
  check((await stateOf(A, 'INV-0003')) === 'paid', 'INV-0003 back to paid once the overpayment was refunded');

  // ---------- 4. a sent invoice, opened and paid in a second browser ----------
  await nav(A, '/invoices');
  await tap(A, { text: /New invoice/ });
  await A.waitFor(`/New invoice/.test(document.querySelector('.page-title').textContent)`, 5000);
  await A.eval(`(() => {
    const byLabel = (t) => document.getElementById([...document.querySelectorAll('label')].find((l) => l.textContent.startsWith(t)).htmlFor);
    const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set(byLabel('Name'), 'Ana Costa'); set(byLabel('Email'), 'ana@example.com'); set(byLabel('Note'), 'Office coffee, October');
    const pick = document.querySelector('[aria-label="Add an item from the catalogue"]');
    pick.value = [...pick.options].find((o) => o.text.startsWith('Flat white')).value; pick.dispatchEvent(new Event('change'));
    set(document.querySelector('[aria-label="Item 1 description"]'), 'Coffee beans, 1 kg');
    set(document.querySelector('[aria-label="Item 1 unit price in zats"]'), '9000');
  })()`);
  await A.eval(`(() => { const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set(document.querySelector('[aria-label="Item 2 quantity"]'), '4'); })()`);
  check(/15,000 zats/.test(await text(A, '.edit-grid')), 'editor: 9,000 + 4 × 1,500 = 15,000 zats, live');
  await tap(A, { text: /^Save draft$/ });
  await A.waitFor(`/Draft/.test(document.querySelector('.page-title').textContent)`, 10000);
  check((await stateOf(A, 'Draft')) === 'draft', 'saved as a draft, not numbered');
  await openInvoice(A, 'Draft');
  await tap(A, { text: /^Issue$/ });
  await A.waitFor(`document.querySelector('.page-title').textContent === 'INV-0004'`, 15000);
  await tap(A, { text: /^Share$/ });
  await A.waitFor(`document.querySelector('.link-text')`, 10000);
  const link = await A.eval(`document.querySelector('.link-text').value`);
  check(/#\/invoice\/[A-Za-z0-9_-]+$/.test(link), `invoice link: ${link.length} characters`);
  await shot(A, 'invoice-detail-1280', true);
  // the second browser: a new wallet, funded by the first customer
  const C = await b.open(`${URL_}#/`, await b.newContext(), 'second');
  await fakeCamera(C);
  await getStarted(C);
  await C.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  await nav(B, '/send');
  await tap(B, { text: /^Show a code$/ });
  await type(B, null, '20000');
  await tap(B, { text: /^Show code$/ });
  await B.waitFor(`document.querySelector('.qr-card canvas')`, 15000);
  await pointCamera(C, { from: B });
  await tap(C, '.tabbar a[data-path="/receive"]');
  await tap(C, { text: /^Scan their code$/ });
  await C.waitFor(result(/Received/), 20000);
  await C.eval(`location.href = ${J(link)}`);
  await C.waitFor(`/Pay 15,000 zats with this wallet/.test(document.querySelector('main').textContent)`, 20000);
  check(!(await C.eval(`!!document.querySelector('.sig-warn')`)) && /Ana Costa/.test(await text(C)) && /Coffee beans, 1 kg/.test(await text(C)) && /Bean & Leaf/.test(await text(C)) && !/ana@example.com/.test(await text(C)), 'customer invoice page: verified, shop, items, total; the email stays on the shop’s device');
  await C.waitFor(`/Waiting for payment/.test(document.querySelector('.cust-status').textContent)`, 15000);
  await shot(C, 'customer-invoice-360', true);
  await tap(C, { text: /^Pay 15,000 zats with this wallet$/ });
  await tap(C, { text: /^Yes, pay 15,000 zats$/ });
  await C.waitFor(result(/Paid/), 20000);
  await nav(C, '/activity');
  check(/Paid INV-0004/.test(await text(C)) && /Invoice INV-0004/.test(await text(C)), 'the paying wallet keeps it in Activity');
  await openInvoice(A, 'INV-0004');
  await A.waitFor(`document.querySelector('.head-badge [data-state="paid"]') && document.querySelector('.receipt-box canvas')`, 40000);
  check(true, 'INV-0004 paid on the shop’s page, with its receipt');
  // a changed link is caught
  const bad = link.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  await C.eval(`location.href = ${J(bad)}`);
  await C.waitFor(`document.querySelector('.sig-warn') || /Can’t open this invoice/.test(document.querySelector('main').textContent)`, 15000);
  check(true, 'a changed invoice link is refused or shown with a warning');

  // ---------- 5. expiry and cancel, enforced by the payment service ----------
  // INV-0005 will expire unpaid; INV-0006 is paid on time while the shop's phone is offline, which
  // only sees the payment after the expiry; INV-0007 is cancelled. Counter sales expire in 1 minute.
  await nav(A, '/shop');
  await fill('Counter sales expire after', '1');
  await tap(A, { text: /^Save$/ });
  const newestCreq = () => A.eval(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes(':pos-requests:'))))[0].request`);
  const counterSale = async () => {
    await nav(A, '/charge');
    await tap(A, { text: /^Green tea/, sel: '.item-btn' });
    await tap(A, { text: /^Charge 1,200 zats$/ });
    await A.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
    return newestCreq();
  };
  const creq5 = await counterSale();
  const creq6 = await counterSale();
  await A.offline(true);
  await A.waitFor(`!document.querySelector('.offline').hidden`, 5000);
  check(/paid 1200 zat/.test(cli('pay', creq6)), 'INV-0006 paid on time, while the shop’s phone is offline');
  log('waiting a minute for INV-0005 and INV-0006 to pass their expiry');
  await sleep(66_000);
  // the payment service refuses INV-0005 now: the CLI (no check first) is told "expired"…
  const late5 = cliTry('pay', creq5);
  const refused = (out) => (out.split('\n').find((l) => l.startsWith('payment refused')) ?? out).slice(0, 110);
  check(/^payment refused \(410\): .*"error":"expired:/m.test(late5) && /"kept":true/.test(late5), `an expired request is refused: ${refused(late5)}`);
  // …and the web wallet checks first and pays nothing
  const payByScan = async (creq) => {
    await nav(B, '/');
    const before = zats(await B.eval(`document.querySelector('.money.balance .m-main').textContent`));
    await pointCamera(B, { text: creq });
    await tap(B, '.tabbar a[data-path="/scan"]');
    await tap(B, { text: /^Pay 1,200 zats$/ });
    await B.waitFor(`/This request (has expired|was cancelled)/.test(document.querySelector('.result-title')?.textContent ?? '')`, 15000);
    const title = await B.eval(`document.querySelector('.result-title').textContent`);
    await nav(B, '/');
    const after = zats(await B.eval(`document.querySelector('.money.balance .m-main').textContent`));
    return { title, unchanged: before === after };
  };
  const p5 = await payByScan(creq5);
  check(p5.title === 'This request has expired' && p5.unchanged, 'the payer’s wallet shows "This request has expired" and pays nothing');
  await shot(B, 'payer-expired-360');
  // the shop's phone comes back: INV-0006 is paid (the server's time says on time), not late
  await A.offline(false);
  await openInvoice(A, 'INV-0006');
  await A.waitFor(`document.querySelector('.head-badge [data-state]')?.dataset.state === 'paid' && !document.querySelector('.pay-row.late')`, 40000);
  check(true, 'INV-0006: the phone saw the payment after the expiry, but it is paid, not late');
  await openInvoice(A, 'INV-0005');
  await A.waitFor(`document.querySelector('.head-badge [data-state="expired"]') && [...document.querySelectorAll('.pay-row.late')].some((r) => r.querySelector('.btn.danger-outline'))`, 40000);
  check(true, 'INV-0005 stays expired; the refused payment the server kept is listed as late, with Refund');
  await A.eval(`document.querySelector('.pay-row.late .btn.danger-outline').click()`);
  await tap(A, { text: /^Make the refund code$/ });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  check(/received 1200/.test(cli('receive', await A.eval(`document.querySelector('.details textarea').value`))), 'the late payment refunded');
  // INV-0007: cancelled at the counter, then refused
  await nav(A, '/shop');
  await fill('Counter sales expire after', '15');
  await tap(A, { text: /^Save$/ });
  const creq7 = await counterSale();
  await tap(A, { text: /^Cancel$/, sel: '.cust-cancel' });
  await tap(A, { text: /^Yes, cancel the sale$/ });
  await A.waitFor(`location.hash === '#/charge'`, 10000);
  const late7 = cliTry('pay', creq7);
  check(/^payment refused \(410\): .*"error":"cancelled:/m.test(late7), `a cancelled request is refused: ${refused(late7)}`);
  const p7 = await payByScan(creq7);
  check(p7.title === 'This request was cancelled' && p7.unchanged, 'the payer’s wallet shows "This request was cancelled" and pays nothing');
  check((await stateOf(A, 'INV-0007')) === 'cancelled', 'INV-0007 stays cancelled');

  // ---------- PDFs and CSV ----------
  await openInvoice(A, 'INV-0004');
  const [invPdf] = await downloads(() => tap(A, { text: /^PDF$/ }));
  const ip = await pdfText(invPdf);
  check(ip.pages === 1 && /INV-0004/.test(ip.text) && /15,000 zats/.test(ip.text) && /Bean & Leaf/.test(ip.text) && /Ana Costa/.test(ip.text), `invoice PDF: valid, ${ip.pages} page, number, total, shop, customer`);
  pdfShot(invPdf, 'pdf-invoice');
  const [rA4] = await downloads(() => tap(A, { text: /^Receipt PDF$/ }));
  const ra = await pdfText(rA4);
  check(/INV-0004/.test(ra.text) && /15,000 zats/.test(ra.text) && /RECEIPT/.test(ra.text), 'receipt PDF (A4): valid, number, total');
  pdfShot(rA4, 'pdf-receipt-a4');
  const [r80] = await downloads(() => tap(A, { text: /^Receipt PDF \(80 mm\)$/ }));
  const rn = await pdfText(r80);
  check(Math.abs(rn.size.width - 226.77) < 1 && /INV-0004/.test(rn.text) && /15,000 zats/.test(rn.text), `receipt PDF (80 mm): ${rn.size.width.toFixed(1)} pt wide, number, total`);
  pdfShot(r80, 'pdf-receipt-80mm');
  // an open invoice's PDF carries its payment code and link
  await nav(A, '/invoices');
  await tap(A, { text: /New invoice/ });
  await A.eval(`(() => { const set = (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set(document.querySelector('[aria-label="Item 1 description"]'), 'Espresso machine service'); set(document.querySelector('[aria-label="Item 1 unit price in zats"]'), '25000'); })()`);
  await tap(A, { text: /^Issue$/ });
  await A.waitFor(`document.querySelector('.page-title').textContent === 'INV-0008'`, 15000);
  const [openPdf] = await downloads(() => tap(A, { text: /^PDF$/ }));
  const op = await pdfText(openPdf);
  check(/INV-0008/.test(op.text) && /25,000 zats/.test(op.text) && /OPEN/.test(op.text) && /#\/invoice\//.test(op.text), 'open invoice PDF: number, total, OPEN, the payment link');
  // CSV
  await nav(A, '/invoices');
  const [csvFile] = await downloads(() => tap(A, { text: /^Export CSV$/ }));
  const csv = readFileSync(csvFile, 'utf8').trim().split('\r\n');
  check(csv[0].startsWith('number,kind,state,customer') && csv.length === 9 && csv.some((l) => l.startsWith('INV-0004,sent,paid,Ana Costa,ana@example.com')), `CSV: a header and 8 invoices (${csv.length - 1})`);
  const [linesFile] = await downloads(() => tap(A, { text: /^Line items CSV$/ }));
  check(readFileSync(linesFile, 'utf8').includes('INV-0004,paid,') && readFileSync(linesFile, 'utf8').includes('"Coffee beans, 1 kg"'), 'line items CSV');
  await shot(A, 'invoices-1280', true);

  // ---------- the dashboard against the invoices ----------
  await nav(A, '/dashboard');
  await A.waitFor(`document.querySelectorAll('.tile').length === 6`, 10000);
  await A.eval(`[...document.querySelectorAll('.chip-btn')].find((b) => b.textContent === 'Today').click()`);
  await sleep(400);
  const tiles = await A.eval(`Object.fromEntries([...document.querySelectorAll('.tile')].map((t) => [t.querySelector('.tile-label').textContent, (t.querySelector('.m-main') ?? t.querySelector('.tile-value')).textContent]))`);
  // from the CSV: paid invoices' paid minus refunded (the overpayment's refund nets it back to 1,200)
  const rows = csv.slice(1).map((l) => l.split(','));
  const sold = rows.filter((r) => ['paid', 'overpaid', 'part-refunded'].includes(r[2]));
  const salesSum = sold.reduce((a, r) => a + Number(r[11]) - Number(r[12]), 0);
  const openSum = rows.filter((r) => ['open', 'partial'].includes(r[2])).reduce((a, r) => a + Number(r[10]) - Number(r[11]), 0);
  log('tiles:', JSON.stringify(tiles), 'from the CSV: sales', salesSum, 'open', openSum);
  check(zats(tiles.Sales) === salesSum && salesSum === 7000 + 5000 + 1200 + 15000 + 1200, `dashboard Sales ${tiles.Sales} = the paid invoices (7,000 + 5,000 + 1,200 + 15,000 + 1,200)`);
  check(zats(tiles['Paid invoices']) === sold.length && zats(tiles['Average sale']) === Math.round(salesSum / sold.length), `paid invoices ${tiles['Paid invoices']}, average ${tiles['Average sale']}`);
  check(zats(tiles['Open / unpaid']) === openSum && openSum === 25000, `open / unpaid ${tiles['Open / unpaid']} (INV-0008)`);
  check(zats(tiles.Refunds) === 2400, `refunds ${tiles.Refunds} (the overpayment and the late payment)`);
  await A.eval(`document.querySelector('.bars .bar:last-of-type').dispatchEvent(new Event('mouseenter'))`);
  await shot(A, 'dashboard-1280', true);
  const [rep] = await downloads(() => tap(A, { text: /^Sales report PDF$/ }));
  const rp = await pdfText(rep);
  check(/Sales report/.test(rp.text) && /INV-0004/.test(rp.text) && /29,400 zats/.test(rp.text) && /Almond cake/.test(rp.text), 'sales report PDF: totals, top items, invoices');
  pdfShot(rep, 'pdf-sales-report');

  // ---------- 360 px ----------
  await A.emulate('phone');
  for (const [path, name, full] of [['/shop', 'setup-360', true], ['/invoices', 'invoices-360', true], ['/dashboard', 'dashboard-360', true]]) {
    await nav(A, '/charge');
    await nav(A, path);
    await sleep(600);
    await shot(A, name, full);
  }
  await openInvoice(A, 'INV-0004');
  await shot(A, 'invoice-detail-360', true);
  await nav(A, '/charge');
  await tap(A, { text: /^Flat white/, sel: '.item-btn' });
  await shot(A, 'charge-360', true);
  await tap(A, { text: /^Charge 1,500 zats$/ });
  await A.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
  await shot(A, 'customer-360');
  await pointCamera(B, { from: A });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await tap(B, { text: /^Pay 1,500 zats$/ });
  await A.waitFor(`/Paid ✓/.test(document.querySelector('.customer')?.textContent ?? '') && document.querySelector('.cust-receipt canvas')`, 30000);
  await shot(A, 'paid-360', true);
  await A.emulate('desktop');
  await C.emulate('desktop');
  await C.eval(`location.href = ${J(link)}`);
  await C.waitFor(`/Bean & Leaf/.test(document.querySelector('main').textContent)`, 15000);
  await sleep(1500);
  await shot(C, 'customer-invoice-1280', true);

  for (const p of [A, B, C]) if (p.errors.filter((e) => !/vite/.test(e)).length) log(`${p.name} console:`, p.errors.filter((e) => !/vite/.test(e)).slice(0, 5));
  log(`screenshots, PDFs and CSVs in ${OUT}: ${shots.join(', ')}`);
  log('ALL PASSED');
} finally {
  b.close();
}
