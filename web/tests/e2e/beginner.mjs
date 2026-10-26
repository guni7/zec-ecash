// The beginner run: two new phones do each everyday task from Home, by the shortest path, with
// real taps (touch events at the element's centre, only if visible and on top) and scans of each
// other's screens. It reports the taps each task took; typing an amount is counted apart.
//
//   scripts/devnet-up.sh; cd web; node --experimental-websocket tests/e2e/beginner.mjs
//
// Moves regtest coins only (the devnet user wallet pays the deposit; devnet/mine.sh mines).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { balance, fakeCamera, getStarted, nav, pointCamera, tap, type } from './ui.mjs';

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

const report = [];
/** Runs one task on `who` from Home, counting its taps. */
async function task(name, who, path, run) {
  for (const p of who) {
    await nav(p, '/');
    p.taps = 0;
    p.typed = 0;
  }
  await run();
  const taps = who.reduce((a, p) => a + p.taps, 0);
  const typed = who.reduce((a, p) => a + p.typed, 0);
  report.push({ task: name, taps, typed, path });
  console.log(`${name.padEnd(28)} ${String(taps).padStart(2)} tap${taps === 1 ? ' ' : 's'}${typed ? ` + ${typed} amount typed` : ''}   ${path}`);
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
  report.push({ task: 'First run (once)', taps: A.taps, typed: 0, path: 'Get started' });
  console.log(`${'First run (once)'.padEnd(28)} ${String(A.taps).padStart(2)} tap    Get started`);
  for (const p of [A, B]) await p.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);

  await task('Add money', [A], 'Add money › type 0.0006 › Get address › (pay from any Zcash wallet)', async () => {
    await tap(A, { text: /^Add money$/ });
    await type(A, null, '0.0006');
    await tap(A, { text: /^Get address$/ });
    await A.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
    const addr = await A.eval(`document.querySelector('.pay .chip').title`);
    sh('./target/debug/devwallet', ['send', addr, '60000']);
    await A.waitFor(result(/Added/), 240000, mine);
  });

  await task('Send by showing a code', [A], 'Send › Show a code › type 0.0003 › Show code', async () => {
    await tap(A, '.tabbar a[data-path="/send"]');
    await tap(A, { text: /^Show a code$/ });
    await type(A, null, '0.0003'); // the amount field has focus
    await tap(A, { text: /^Show code$/ });
    await A.waitFor(`!!document.querySelector('.qr-card canvas')`, 15000);
  });

  await task('Receive by scanning', [B], 'Receive › Scan their code', async () => {
    await pointCamera(B, { from: A });
    await tap(B, '.tabbar a[data-path="/receive"]');
    await tap(B, { text: /^Scan their code$/ });
    await B.waitFor(result(/Received/), 20000);
  });
  await A.waitFor(result(/Picked up/), 15000);

  await task('Ask for an amount', [A], 'Receive › Show my code › type 0.00002 › Show code', async () => {
    await tap(A, '.tabbar a[data-path="/receive"]');
    await tap(A, { text: /^Show my code$/ });
    await type(A, null, '0.00002');
    await tap(A, { text: /^Show code$/ });
    await A.waitFor(`/Waiting for payment/.test(document.querySelector('.status-line')?.textContent ?? '')`, 15000);
  });

  await task('Pay someone’s code', [B], 'Scan › Pay', async () => {
    await pointCamera(B, { from: A });
    await tap(B, '.tabbar a[data-path="/scan"]');
    await tap(B, { text: /^Pay / });
    await B.waitFor(result(/Paid/), 20000);
  });
  await A.waitFor(result(/Received/), 30000);

  const uri = `zcash:${userAddr}?amount=0.00003`;
  await task('Cash out (a payment link)', [B], 'Scan › Review › Cash out', async () => {
    await pointCamera(B, { text: uri });
    await tap(B, '.tabbar a[data-path="/scan"]');
    await B.waitFor(`location.hash === '#/withdraw' && document.querySelector('.amount-input').value === '0.00003'`, 15000);
    await tap(B, { text: /^Review$/ });
    await tap(B, '.review .btn.confirm');
    await B.waitFor(result(/Sent/), 300000, mine);
  });
  await task('Cash out (from the button)', [A], 'Cash out › Scan › Review › Cash out', async () => {
    await pointCamera(A, { text: uri });
    await tap(A, { text: /^Cash out$/ });
    await tap(A, { text: /^Scan$/ });
    await A.waitFor(`document.querySelector('.amount-input').value === '0.00003'`, 15000);
    await tap(A, { text: /^Review$/ });
    await tap(A, '.review .btn.confirm');
    await A.waitFor(result(/Sent/), 300000, mine);
  });

  console.log(`balances: A ${await balance(A)}, B ${await balance(B)} zats`);
  writeFileSync(join(OUT, 'beginner.json'), JSON.stringify(report, null, 2));
  console.log(`report in ${join(OUT, 'beginner.json')}`);
  for (const p of [A, B]) if (p.errors.filter((e) => !/vite/.test(e)).length) console.log(`${p.name} console:`, p.errors);
  console.log('ALL TASKS DONE');
} finally {
  b.close();
}
