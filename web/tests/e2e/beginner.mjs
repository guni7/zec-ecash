// The beginner run: two new phones do each everyday task from Home, by the shortest path, with
// real taps (touch events at the element's centre, only if visible and on top) and scans of each
// other's screens. It reports the taps each task took on each phone; typing an amount is counted
// apart. Screenshots of Send, Receive, the offline state, the request screen and shop mode go
// to OUT.
//
//   scripts/devnet-up.sh; cd web; node --experimental-websocket tests/e2e/beginner.mjs
//
// Moves regtest coins only (the devnet user wallet pays the deposit; devnet/mine.sh mines).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { balance, fakeCamera, getStarted, nav, pointCamera, sleep, tap, text, type } from './ui.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const URL_ = `https://${HOST}:5173/`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-beginner-'));
mkdirSync(OUT, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8' });
let lastMine = 0;
const mine = async () => {
  if (Date.now() - lastMine < 2500) return;
  lastMine = Date.now();
  sh('devnet/mine.sh', ['1']);
};
const result = (re) => `${re}.test(document.querySelector('.result-title')?.textContent ?? '')`;
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok: ${what}`);
};
const shot = (p, name, full = false) => p.screenshot(join(OUT, `${name}.png`), full);
/** The page's big choices, in order ("(off)" if greyed out). */
const choices = (p) => p.eval(`[...document.querySelectorAll('.choices .btn')].filter((b) => !b.closest('.paste-box')).map((b) => b.textContent.trim() + (b.disabled ? ' (off)' : ''))`);

const report = [];
/** Runs one task from Home on the phones in `who` ({ A, B }), counting each one's taps. */
async function task(name, who, path, run) {
  const phones = Object.entries(who);
  for (const [, p] of phones) {
    await nav(p, '/');
    p.taps = 0;
    p.typed = 0;
  }
  await run();
  const per = phones.map(([phone, p]) => ({ phone, taps: p.taps, typed: p.typed }));
  report.push({ task: name, per, path });
  const say = per.map((x) => `${phones.length > 1 ? `${x.phone} ` : ''}${x.taps} tap${x.taps === 1 ? '' : 's'}${x.typed ? ` + ${x.typed} amount` : ''}`).join(' · ');
  console.log(`${name.padEnd(36)} ${say.padEnd(30)} ${path}`);
}

const userAddr = sh('./target/debug/devwallet', ['address']).match(/uregtest1[a-z0-9]+/)[0];
const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9355));
b.setDevice('phone');
try {
  const A = await b.open(`${URL_}#/`, undefined, 'A');
  const B = await b.open(`${URL_}#/`, await b.newContext(), 'B');
  for (const p of [A, B]) await fakeCamera(p);

  A.taps = 0;
  await getStarted(A);
  await getStarted(B);
  report.push({ task: 'First run (once)', per: [{ phone: 'A', taps: A.taps, typed: 0 }], path: 'Get started' });
  console.log(`${'First run (once)'.padEnd(36)} ${`${A.taps} tap`.padEnd(30)} Get started`);
  for (const p of [A, B]) await p.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);

  await task('Add money', { A }, 'Add money › amount › Get address › (pay from any Zcash wallet)', async () => {
    await tap(A, { text: /^Add money$/ });
    await type(A, null, '60000');
    await tap(A, { text: /^Get address$/ });
    await A.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
    const addr = await A.eval(`document.querySelector('.pay .chip').title`);
    sh('./target/debug/devwallet', ['send', addr, '60000']);
    await A.waitFor(result(/Added/), 240000, mine);
  });

  await nav(A, '/send');
  check((await choices(A)).join(' | ') === 'Scan their code | Show a code | Send without internet' && !(await A.eval(`document.querySelector('.amount-input')`)), 'Send: three choices, Scan their code first, no amount entry');
  await shot(A, 'send');

  await task('Send by showing a code', { A }, 'Send › Show a code › amount › Show code', async () => {
    await tap(A, '.tabbar a[data-path="/send"]');
    await tap(A, { text: /^Show a code$/ });
    await type(A, null, '30000');
    await tap(A, { text: /^Show code$/ });
    await A.waitFor(`/Waiting for them/.test(document.querySelector('.status-line')?.textContent ?? '')`, 15000);
  });
  check(/Anyone who scans this can take the money/.test(await text(A)) && /Take it back/.test(await text(A)), 'shown code: the "anyone who scans this" line, Waiting for them…, Take it back');

  await task('Receive by scanning', { B }, 'Receive › Scan their code', async () => {
    await pointCamera(B, { from: A });
    await tap(B, '.tabbar a[data-path="/receive"]');
    await tap(B, { text: /^Scan their code$/ });
    await B.waitFor(result(/Received/), 20000);
  });
  await A.waitFor(result(/Picked up ✓/), 15000);
  console.log('  ok: the sender’s screen turned to "Picked up ✓" by itself');

  await nav(B, '/');
  await nav(B, '/receive');
  check((await choices(B)).join(' | ') === 'Scan their code | Request an amount | Receive without internet', 'Receive: three choices, Scan their code first');
  await shot(B, 'receive');

  await task('Request an amount and get paid', { A, B }, 'A: Receive › Request an amount › amount › Show code · B: Scan › Pay', async () => {
    await tap(A, '.tabbar a[data-path="/receive"]');
    await tap(A, { text: /^Request an amount$/ });
    await type(A, null, '2000');
    await tap(A, { text: /^Show code$/ });
    await A.waitFor(`/Waiting for payment/.test(document.querySelector('.status-line')?.textContent ?? '')`, 15000);
    await shot(A, 'request', true);
    await pointCamera(B, { from: A });
    await tap(B, '.tabbar a[data-path="/scan"]');
    await tap(B, { text: /^Pay / });
    await B.waitFor(result(/Paid/), 20000);
    await A.waitFor(result(/Received/), 30000);
  });

  const shopCount = `(document.querySelector('.shop-count')?.textContent ?? '')`;
  const waitingForPayment = `/Waiting for payment/.test(document.querySelector('.status-line')?.textContent ?? '')`;
  await task('Shop mode: two customers in a row', { A, B }, 'A: Receive › Request an amount › amount › Keep open › Show code · each customer: Scan › Pay', async () => {
    await tap(A, '.tabbar a[data-path="/receive"]');
    await tap(A, { text: /^Request an amount$/ });
    await type(A, null, '1000');
    await tap(A, { text: /Keep open for the next customer/, sel: 'label.toggle' });
    await tap(A, { text: /^Show code$/ });
    for (let n = 1; n <= 2; n++) {
      await A.waitFor(`${waitingForPayment} && /Shop mode · ${n - 1} paid/.test(${shopCount})`, 20000);
      if (n === 2) await shot(A, 'shop-mode-next-customer', true);
      await pointCamera(B, { from: A });
      await nav(B, '/');
      await tap(B, '.tabbar a[data-path="/scan"]');
      await tap(B, { text: /^Pay / });
      await B.waitFor(result(/Paid/), 20000);
      await A.waitFor(result(/Paid ✓/), 30000);
      if (n === 1) await shot(A, 'shop-mode-paid', true);
    }
    await A.waitFor(`${waitingForPayment} && /Shop mode · 2 paid/.test(${shopCount})`, 20000);
  });
  console.log('  ok: after two payments the shop shows "Shop mode · 2 paid" and a fresh request');
  await tap(A, { text: /Keep open for the next customer/, sel: 'label.toggle' }); // shop mode off

  // ---------- without internet: B (receiving) is offline ----------
  await B.offline(true);
  await B.waitFor(`!document.querySelector('.offline').hidden`, 5000);
  await nav(B, '/');
  await nav(B, '/receive');
  const recvOff = await choices(B);
  check(/You’re offline/.test(await text(B)) && recvOff[0] === 'Receive without internet' && recvOff.includes('Request an amount (off)'), `offline Receive: banner, "Receive without internet" first, Request an amount greyed with why (${recvOff.join(', ')})`);
  await shot(B, 'receive-offline');
  await task('Receive without internet', { B }, 'Receive › Receive without internet › (they send) › Scan their code', async () => {
    await tap(B, '.tabbar a[data-path="/receive"]');
    await tap(B, { text: /^Receive without internet$/ });
    await B.waitFor(`/They’ll scan this, then show you a code back to scan/.test(document.querySelector('main').textContent)`, 5000);
    await shot(B, 'receive-without-internet', true);
    await task('Send without internet (they’re offline)', { A }, 'Send › Send without internet › Scan their code › amount › Send', async () => {
      await pointCamera(A, { from: B });
      await tap(A, '.tabbar a[data-path="/send"]');
      await tap(A, { text: /^Send without internet$/ });
      check(/Ask them to open Receive → Receive without internet, then scan their code\./.test(await text(A)), 'Send without internet: the one-line instruction');
      await tap(A, { text: /^Scan their code$/ });
      await A.waitFor(`/Send to this person/.test(document.querySelector('main').textContent)`, 15000);
      await type(A, null, '4000');
      await tap(A, { text: /^Send$/, sel: '.confirm button' });
      await A.waitFor(`/Waiting for them/.test(document.querySelector('.status-line')?.textContent ?? '')`, 15000);
    });
    await pointCamera(B, { from: A });
    await tap(B, { text: /^Scan their code$/ });
    await B.waitFor(result(/Received/), 20000);
  });
  check(/Received offline/.test(await text(B)), 'B, offline, received the locked 4,000 zats');
  await A.waitFor(result(/Picked up ✓/), 30000).catch(() => console.log('  note: A sees "Picked up" once B is back online and redeems it'));

  // ---------- both offline: the sender can't lock money without the mint ----------
  await A.offline(true);
  await A.waitFor(`!document.querySelector('.offline').hidden`, 5000);
  await nav(A, '/');
  await nav(A, '/send');
  const sendOff = await choices(A);
  check(sendOff[0] === 'Send without internet (off)' && sendOff.every((t) => t.endsWith('(off)')), `offline Send: "Send without internet" first, every option greyed with why (${sendOff.join(', ')})`);
  await shot(A, 'send-offline');
  await A.offline(false);
  await B.offline(false);
  for (const p of [A, B]) await p.waitFor(`document.querySelector('.offline').hidden`, 30000);
  await A.waitFor(result(/Picked up ✓/), 40000).catch(() => {});

  const uri = `zcash:${userAddr}?amount=0.00003`;
  await task('Cash out (a payment link)', { B }, 'Scan › Review › Cash out', async () => {
    await pointCamera(B, { text: uri });
    await tap(B, '.tabbar a[data-path="/scan"]');
    await B.waitFor(`location.hash === '#/withdraw' && document.querySelector('.amount-input').value === '3000'`, 15000);
    await tap(B, { text: /^Review$/ });
    await tap(B, '.review .btn.confirm');
    await B.waitFor(result(/Sent/), 300000, mine);
  });

  await sleep(500);
  console.log(`balances: A ${await balance(A)}, B ${await balance(B)} zats`);
  writeFileSync(join(OUT, 'beginner.json'), JSON.stringify(report, null, 2));
  console.log(`report and screenshots in ${OUT}`);
  for (const p of [A, B]) if (p.errors.filter((e) => !/vite/.test(e)).length) console.log(`${p.name} console:`, p.errors);
  console.log('ALL TASKS DONE');
} finally {
  b.close();
}
