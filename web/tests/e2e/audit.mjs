// Accessibility audit of every page, and the states behind its first tap, on a 360 px phone
// (devnet web server running):
// text contrast >= 4.5:1 (3:1 for large text) against the real background, tap targets >= 44 px,
// and every control labelled.   node --experimental-websocket tests/e2e/audit.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';
import { AUDIT } from './ui.mjs';

const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
/** [page, what to tap first (in the page), label]. A fresh wallet: Home starts with the first-run screen. */
const PAGES = [
  ['/welcome'],
  ['/', `document.querySelector('.welcome .btn.primary')?.click()`, 'home (empty)'],
  ['/send'],
  ['/scan', null, 'scan (no camera: paste box)'],
  ['/receive'],
  ['/receive', `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Request an amount').click()`, 'receive · request an amount'],
  ['/receive', `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Receive without internet').click()`, 'receive · without internet'],
  ['/activity'],
  ['/deposit'],
  ['/withdraw'],
  ['/status'],
  ['/status', `document.querySelector('details summary').click()`, 'status · details'],
  ['/settings'],
  ['/settings', `document.querySelector('details summary').click()`, 'settings · advanced'],
];


const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-audit-')), 9352);
b.setDevice('phone');
let total = 0;
try {
  const p = await b.open(`https://${HOST}:5173/#/`, undefined, 'audit');
  await new Promise((r) => setTimeout(r, 2000));
  for (const [path, first, label] of PAGES) {
    await p.eval(`location.hash = '#/activity'`);
    await new Promise((r) => setTimeout(r, 200));
    await p.eval(`location.hash = '#${path}'`);
    await new Promise((r) => setTimeout(r, path === '/status' ? 1500 : 600));
    if (first) {
      await p.eval(first);
      await new Promise((r) => setTimeout(r, 600));
    }
    const bad = await p.eval(AUDIT);
    total += bad.length;
    console.log(`${(label ?? path).padEnd(30)} ${bad.length ? bad.length + ' issue(s)' : 'ok'}`);
    for (const x of bad) console.log(`   ${x}`);
  }
} finally {
  b.close();
}
process.exitCode = total ? 1 : 0;
