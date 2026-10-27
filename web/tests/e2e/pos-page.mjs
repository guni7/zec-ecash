// Devnet browser test of the locked point of sale on the page (360 px phone, headless Chrome):
//   1. the page creates a request (Receive › Request an amount); `zec-ecash-cli pay` pays it (locked, DLEQ, no refund); the
//      page collects it automatically, even though the mint's answer to the first swap is lost
//      (NUT-09 restore); balance up; the server's copy deleted;
//   2. the phone is offline (and reloaded) when another phone pays it (Send › Paste instead); it
//      collects once back online;
//   3. a wallet restored from its seed alone re-derives the key, finds the request, collects;
//   4. two concurrent payers (the CLI and another phone's page) plus a late one: one PAID and
//      two extra payments, all collected; one extra refunded unlocked, one locked to the payer;
//   5. an underpayment (locked, valid): kept as a partial payment, the request stays unpaid, the
//      page shows "received X of Y", collects it, refunds it; a full payment then pays it.
//   scripts/devnet-up.sh; cd web; OUT=<dir> node --experimental-websocket tests/e2e/pos-page.mjs
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const URL_ = `https://${HOST}:5173/`;
const MINT = `https://${HOST}:5173/mint`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-pos-'));
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ZEC_MINT_CA: 'web/certs/rootCA.pem' } });
const sql = (q) => sh('sqlite3', ['devnet/pos/pos.sqlite', q]).trim();
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  log(`ok: ${what}`);
};
const J = JSON.stringify;
const fill = (sel, v) => `(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const click = (sel) => `document.querySelector(${J(sel)}).click()`;
const txt = (sel) => `(document.querySelector(${J(sel)})?.textContent ?? '')`;
const nav = async (p, path) => {
  await p.eval(`location.hash = ${J(`#${path}`)}`);
  await sleep(400);
};
const balance = async (p) => {
  await nav(p, '/');
  return p.eval(`Number(document.querySelector('.money.balance .m-sub').textContent.replace(/[^0-9]/g, ''))`);
};
const shot = (p, name) => p.screenshot(join(OUT, `${name}.png`), false);
const btn = (re, scope = 'main') => `[...document.querySelector(${J(scope)}).querySelectorAll('button')].find((b) => ${re}.test(b.textContent.trim()))`;
const result = `(document.querySelector('.result-title')?.textContent ?? '')`;
const main = `document.querySelector('main').textContent`;
/** Asks for an amount (Receive › Request an amount); returns {id, creq}. */
async function createRequest(p, amount) {
  await nav(p, '/');
  await nav(p, '/receive');
  await p.eval(`${btn('/^Request an amount$/')}.click()`);
  await p.waitFor(`!!document.querySelector('.confirm .amount-input')`, 5000);
  await p.eval(fill('.confirm .amount-input', String(amount)));
  await p.eval(`${btn('/^Show code$/')}.click()`);
  await p.waitFor(`location.hash.startsWith('#/receive?r=')`, 15000);
  const id = decodeURIComponent(await p.eval(`location.hash.split('r=')[1]`));
  const creq = await p.eval(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':pos-requests:')))).find((r) => r.id === ${J(id)}).request`);
  return { id, creq };
}
/** Pastes a code on a page's scan block (no camera here) and continues. */
async function paste(p, path, code) {
  await nav(p, '/');
  await nav(p, path);
  await p.eval(`${btn('/^Paste instead$/')}.click()`);
  await p.eval(fill('.paste-box textarea', code));
  await p.eval(`${btn('/^Continue$/')}.click()`);
}
/** Funds a phone with a CLI token: Receive › Paste instead. */
async function fund(p, token) {
  await paste(p, '/receive', token);
  await p.waitFor(`/Received/.test(${result})`, 15000);
}
/** Drops the page's /mint/v1/swap responses (the mint still does the swap). Returns stop(). */
async function dropSwaps(p) {
  const dropped = [];
  const listener = async (m) => {
    if (m.sessionId !== p.s || m.method !== 'Fetch.requestPaused') return;
    if (m.params.responseStatusCode !== undefined && m.params.request.url.endsWith('/mint/v1/swap')) {
      dropped.push(m.params.responseStatusCode);
      await p.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionReset' });
    } else await p.send('Fetch.continueRequest', { requestId: m.params.requestId });
  };
  p.b.listeners.push(listener);
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/mint/v1/swap', requestStage: 'Response' }] });
  return {
    dropped,
    stop: async () => {
      await p.send('Fetch.disable');
      p.b.listeners.splice(p.b.listeners.indexOf(listener), 1);
    },
  };
}

const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9360));
b.setDevice('phone');
try {
  const A = await b.open(`${URL_}#/request`, undefined, 'A');
  await A.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  check((await A.eval('location.hash')) === '#/receive', 'the old #/request link opens Receive');

  // ---------- 1. CLI pays a page request; the page collects (first swap answer lost) ----------
  const r1 = await createRequest(A, 1500);
  check(/Waiting for payment/.test(await A.eval(txt('.status-line'))), `request ${r1.id.slice(0, 8)}… waiting for payment`);
  await shot(A, 'request-waiting');
  const pub1 = sql(`SELECT pubkey FROM pos_quote WHERE id='${r1.id}'`);
  const stored = await A.eval(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':pos-requests:'))))[0]`);
  check(stored.pubkey === pub1 && stored.index >= 0, `request locked to the page's derived key #${stored.index} (${pub1.slice(0, 12)}…)`);
  const drop = await dropSwaps(A);
  const paid = sh('./target/release/zec-ecash-cli', ['pay', r1.creq]);
  check(/paid 1500 zat/.test(paid), `zec-ecash-cli paid the locked request: ${paid.trim().split('\n').pop().slice(0, 90)}`);
  const lock = JSON.parse(sql(`SELECT proofs FROM pos_quote WHERE id='${r1.id}'`)).map((p) => JSON.parse(p.secret));
  check(lock.every(([k, d]) => k === 'P2PK' && d.data === pub1 && !(d.tags ?? []).length), 'CLI locked every proof to exactly the request key, no locktime/refund tags');
  await A.waitFor(`/Paid · receiving/.test(${txt('.status-line')})`, 20000);
  await A.waitFor(`${J(drop.dropped)} && true`, 1000).catch(() => {});
  await sleep(3500);
  check(drop.dropped.length >= 1, `the mint did the swap but its answer was lost (${drop.dropped.length} dropped)`);
  await shot(A, 'request-paid-collecting');
  await nav(A, '/activity');
  await A.waitFor(`/In progress/.test(${main}) && /paid · receiving/.test(${main})`, 5000);
  await shot(A, 'activity-to-collect');
  await drop.stop();
  await nav(A, `/request?r=${r1.id}`);
  await A.waitFor(`/Received/.test(${result})`, 30000);
  await sleep(700);
  await shot(A, 'request-collected');
  check((await balance(A)) === 1500, 'page balance 1,500 after collecting (recovered with NUT-09 restore)');
  check(sql(`SELECT token IS NULL AND collected_at IS NOT NULL FROM pos_quote WHERE id='${r1.id}'`) === '1', "server's copy deleted after the page's ack");

  // ---------- 2. phone offline when paid (and reloaded); collects when back online ----------
  const r2 = await createRequest(A, 800);
  await A.offline(true);
  await A.reload();
  await A.waitFor(`/Offline/.test(${txt('.offline')})`, 10000);
  log('phone A offline (and reloaded) before the payment');
  const B = await b.open(`${URL_}#/receive`, await b.newContext(), 'B');
  await B.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  await fund(B, sh('./target/release/zec-ecash-cli', ['send', '1000']).match(/cashuB[A-Za-z0-9_-]+/)[0]);
  await paste(B, '/send', r2.creq);
  await B.waitFor(`/Pay this code/.test(${main})`, 5000);
  check(/800 zats/.test(await B.eval(txt('.confirm'))) && /Locked to/.test(await B.eval(txt('.confirm .details'))), `payer page reads the request: ${(await B.eval(txt('.confirm'))).slice(0, 60)}`);
  await B.eval(`${btn('/^Pay /')}.click()`);
  await B.waitFor(`/Paid/.test(${result})`, 20000);
  await shot(B, 'payer-paid');
  check(sql(`SELECT state FROM pos_quote WHERE id='${r2.id}'`) === 'PAID', "B's page paid A's request (locked; A is offline)");
  await sleep(2000);
  check(sql(`SELECT token IS NOT NULL FROM pos_quote WHERE id='${r2.id}'`) === '1', 'payment waits on the server while A is offline');
  await A.offline(false);
  await nav(A, `/request?r=${r2.id}`);
  await A.waitFor(`/Received/.test(${result})`, 40000);
  check((await balance(A)) === 2300, 'A back online: collected 800, balance 2,300');

  // ---------- 3. a wallet restored from its seed alone ----------
  const r3 = await createRequest(A, 700);
  await A.offline(true); // A never sees this payment
  sh('./target/release/zec-ecash-cli', ['pay', r3.creq]);
  const seed = await A.eval(`localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':seed:')))`);
  const R = await b.open(`${URL_}#/settings`, await b.newContext(), 'R');
  await R.eval(`localStorage.clear(); localStorage.setItem('zec-ecash-demo:seed:${MINT}', ${J(seed)})`);
  await R.reload();
  await R.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  await nav(R, '/activity');
  await R.waitFor(`/paid to your code/.test(document.body.innerText)`, 40000);
  const found = await R.eval(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':pos-requests:'))) || '[]').map(r => [r.id, r.index, r.state])`);
  check(found.some(([id, , st]) => id === r3.id && st === 'done'), `restored wallet (seed only) found request ${r3.id.slice(0, 8)}… by its derived key and collected it (${J(found.map(([, i, s]) => `#${i}:${s}`))})`);
  check((await balance(R)) === 700, 'restored wallet balance 700');
  await shot(R, 'restored-activity');
  const next = await R.eval(`Number(localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':pos-next:'))))`);
  check(next > Math.max(...found.map(([, i]) => i)), `restored wallet won't reuse a key: next index ${next}`);

  // ---------- 4. extra payments: a race, a late payment, both collected; refunds ----------
  await A.offline(false);
  await A.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  const before = await balance(A);
  const r4 = await createRequest(A, 600);
  // B (another phone's page) needs funds too
  await fund(B, sh('./target/release/zec-ecash-cli', ['send', '1000']).match(/cashuB[A-Za-z0-9_-]+/)[0]);
  await paste(B, '/send', r4.creq);
  await B.waitFor(`/Pay this code/.test(${main})`, 5000);
  // the CLI and B's page pay at the same moment
  const cliPay = new Promise((res) => execFile('./target/release/zec-ecash-cli', ['pay', r4.creq], { cwd: REPO, env: { ...process.env, ZEC_MINT_CA: 'web/certs/rootCA.pem' } }, (e, out) => res(out || String(e))));
  await B.eval(`${btn('/^Pay /')}.click()`);
  const cliOut = await cliPay;
  await B.waitFor(`/Paid/.test(${result})`, 20000);
  const bToast = await B.eval(txt('.result'));
  log('cli:', cliOut.trim().split('\n').pop().slice(0, 140));
  log('payer B:', bToast.slice(0, 120));
  check(sql(`SELECT COUNT(*) FROM pos_extra WHERE quote_id='${r4.id}'`) === '1', 'race: one payment PAID, the other kept as extra payment 1');
  // a late third payment, after PAID
  check(/extra/.test(sh('./target/release/zec-ecash-cli', ['pay', r4.creq])), 'a late payment (request already PAID) becomes extra payment 2');
  await nav(A, `/request?r=${r4.id}`);
  await A.waitFor(`/Received/.test(${result}) && document.querySelectorAll('.extra').length === 2 && [...document.querySelectorAll('.extra')].every(e => /in your wallet/.test(e.textContent))`, 40000);
  check((await A.eval(`[...document.querySelectorAll('.extra strong')].map(e => e.textContent).join(' | ')`)) === 'Extra payment received: 600 zats | Extra payment received: 600 zats', 'Receive page: "Extra payment received: 600 zats" twice');
  check(sql(`SELECT COUNT(*) FROM pos_extra WHERE quote_id='${r4.id}' AND token IS NULL AND collected_at IS NOT NULL`) === '2', "both extra payments collected; server's copies deleted");
  await sleep(500);
  await A.eval(`document.querySelector('.extra').scrollIntoView({ block: 'center' })`);
  await shot(A, 'request-extra-payments');
  check((await balance(A)) === before + 1800, `phone collected the main payment and both extras: balance ${before} + 1,800`);
  await nav(A, '/activity');
  check(/Extra payment received.*in your wallet/.test(await A.eval(main)) && /\+600 zats/.test(await A.eval(main)), 'Activity shows "Extra payment received" +600 zats');
  await shot(A, 'activity-extra');
  // refund 1: unlocked
  await nav(A, `/request?r=${r4.id}`);
  await A.eval(`document.querySelectorAll('.extra')[0].querySelector('.btn.danger-outline').click()`);
  await A.eval(`document.querySelectorAll('.extra')[0].querySelector('.btn.primary').click()`);
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  await shot(A, 'refund-token');
  const refund1 = await A.eval(`document.querySelector('details textarea').value`);
  check(/received 600/.test(sh('./target/release/zec-ecash-cli', ['receive', refund1])), 'refund 1 (unlocked, 600 zat) redeemed by the payer');
  // refund 2: locked to the payer's key
  const payerPub = sh('./target/release/zec-ecash-cli', ['pubkey']).trim();
  await nav(A, `/request?r=${r4.id}`);
  await A.eval(`(() => { const x = [...document.querySelectorAll('.extra')].find(e => e.querySelector('.btn.danger-outline')); x.querySelector('.btn.danger-outline').click(); const t = x.querySelector('textarea'); t.value = ${J(payerPub)}; t.dispatchEvent(new Event('input')); x.querySelector('.btn.primary').click(); })()`);
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const refund2 = await A.eval(`document.querySelector('details textarea').value`);
  check(/Only they can take this money/.test(await A.eval(main)), "refund 2 is locked to the payer's key");
  check(/received 600/.test(sh('./target/release/zec-ecash-cli', ['receive', refund2])), 'refund 2 (locked) redeemed by the payer, signing with its key');
  await nav(A, `/request?r=${r4.id}`);
  check((await A.eval(`[...document.querySelectorAll('.extra')].map(e => /refunded/.test(e.textContent)).every(Boolean)`)), 'both extras now show as refunded');
  await shot(A, 'request-extras-refunded');
  check((await balance(A)) === before + 600, `after both refunds: balance ${before} + 600`);

  // ---------- 5. a partial payment ----------
  const before5 = await balance(A);
  const r5 = await createRequest(A, 900);
  const short = sh('./target/release/zec-ecash-cli', ['pay', r5.creq, '--amount', '250']);
  check(/"partial":true/.test(short) && /received 250 of 900/.test(short), `CLI underpays 250 of 900: kept as a partial payment ("${(short.match(/"note":"([^"]+)"/) ?? [])[1]}")`);
  check(sql(`SELECT state FROM pos_quote WHERE id='${r5.id}'`) === 'UNPAID', 'the request stays unpaid');
  await A.waitFor(`[...document.querySelectorAll('.extra')].some(e => /Partial payment received: 250 zats of 900 zats/.test(e.textContent) && /in your wallet/.test(e.textContent))`, 30000);
  check(/Waiting for payment/.test(await A.eval(txt('.status-line'))) && /Received 250 zats of 900 zats · still unpaid/.test(await A.eval(main)), 'page: still waiting for payment, "Received 250 zats of 900 zats"; the partial is collected');
  check(sql(`SELECT COUNT(*) FROM pos_extra WHERE quote_id='${r5.id}' AND kind='partial' AND token IS NULL AND collected_at IS NOT NULL`) === '1', "partial collected; server's copy deleted");
  await sleep(400);
  await shot(A, 'request-partial');
  await nav(A, '/activity');
  check(/Partial payment received.*of 900 zats/.test(await A.eval(main)), 'Activity: "Partial payment received", of 900 zats');
  await nav(A, `/request?r=${r5.id}`);
  await A.waitFor(`document.querySelector('.extra .btn.danger-outline')`, 10000);
  await A.eval(`document.querySelector('.extra .btn.danger-outline').click(); document.querySelector('.extra .btn.primary').click()`);
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const refund5 = await A.eval(`document.querySelector('details textarea').value`);
  check(/received 250/.test(sh('./target/release/zec-ecash-cli', ['receive', refund5])), 'partial payment refunded (unlocked 250 zat) and redeemed by the payer');
  sh('./target/release/zec-ecash-cli', ['pay', r5.creq]);
  await nav(A, `/request?r=${r5.id}`);
  await A.waitFor(`/Received/.test(${result})`, 30000);
  await sleep(400);
  await shot(A, 'request-partial-then-paid');
  check((await balance(A)) === before5 + 900, `then a full payment paid the request: balance ${before5} + 250 − 250 + 900`);

  for (const p of [A, B, R]) if (p.errors.length) log(`${p.name} console:`, p.errors.slice(0, 5));
  log(`screenshots in ${OUT}`);
  log('ALL PASSED');
} finally {
  b.close();
}
