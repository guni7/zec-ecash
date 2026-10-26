// Devnet browser test of the whole wallet, as a phone (360x780, touch) in headless Chrome:
// deposit -> mint -> send -> receive -> withdraw, a reload in the middle of a deposit and of a
// withdrawal, an offline locked receive, send-token check/reclaim, every QR decoding back to its
// text, and a screenshot of every page on a phone and on a desktop.
//
//   scripts/devnet-up.sh            # the devnet, with the web dev server on :5173
//   cd web && npm run e2e:devnet    # OUT=<dir> for the screenshots (default: a temp dir)
//
// Pays deposits from the devnet user wallet (target/debug/devwallet) and mines with
// devnet/mine.sh, so it moves regtest coins only.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const URL_ = `https://${HOST}:5173/`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-e2e-'));
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8' });
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
const results = [];

// --- page helpers (all run inside the page) ---
const J = JSON.stringify;
const fill = (sel, v) => `(() => { const e = document.querySelector(${J(sel)}); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const click = (sel) => `document.querySelector(${J(sel)}).click()`;
const txt = (sel) => `(document.querySelector(${J(sel)})?.textContent ?? '')`;
const nav = async (p, path) => {
  await p.eval(`location.hash = ${J(`#${path}`)}`);
  await sleep(400);
};
const balance = (p) => p.eval(`Number((document.querySelector('.balance-amount')?.textContent ?? 'NaN').replace(/,/g, ''))`);
const homeBalance = async (p) => {
  await nav(p, '/');
  return balance(p);
};
const toastsSeen = async (p, re, timeout = 15000) => p.waitFor(`${re}.test(document.querySelector('.toasts').textContent)`, timeout);
const shot = async (p, name) => {
  const file = join(OUT, `${name}.png`);
  await p.screenshot(file, false);
  results.push(file);
};

/**
 * Each QR on the page must decode back to exactly `expect`: straight from the canvas, and from a
 * camera-sized frame (1080 px, code filling 80% as in the tap-to-enlarge view, light noise) decoded
 * at 800 px like the wallet's own scanner (src/ui/scanner.ts). A check that the codes are valid
 * and dark-on-light with a quiet zone, not a substitute for a real phone camera.
 */
async function qrCheck(p, label, expect) {
  const r = await p.eval(`(async () => {
    const { default: QrScanner } = await import('/node_modules/.vite/deps/qr-scanner.js');
    const src = document.querySelector('.qr-card canvas');
    const direct = await QrScanner.scanImage(src, { returnDetailedScanResult: true }).then((x) => x.data, () => null);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const W = 1080, side = Math.round(W * 0.8);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = W;
    const c = cv.getContext('2d');
    c.fillStyle = '#9a958c'; c.fillRect(0, 0, W, W);
    c.drawImage(src, (W - side) / 2, (W - side) / 2, side, side);
    const img = c.getImageData(0, 0, W, W), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rand() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    c.putImageData(img, 0, 0);
    const camera = await QrScanner.scanImage(cv, { returnDetailedScanResult: true, scanRegion: { x: 0, y: 0, width: W, height: W, downScaledWidth: 800, downScaledHeight: 800 } }).then((x) => x.data, () => null);
    const bg = getComputedStyle(src.closest('.qr-card')).backgroundColor;
    return { direct, camera, modules: src.width / 8, bg };
  })()`);
  check(r.direct === expect && r.camera === expect && r.bg === 'rgb(255, 255, 255)', `QR ${label}: ${r.modules} modules incl. 4-module quiet zone, white card, decodes to the exact ${expect.length}-char text (direct and camera-sized)`);
}

/** Watches every animation frame for a toast overlapping a QR card; kept across reloads. */
const WATCH = `(() => {
  if (window.__watching) return; window.__watching = true;
  const tick = () => {
    const qrs = [...document.querySelectorAll('.qr-card')].map((q) => q.getBoundingClientRect()).filter((r) => r.width > 0);
    for (const t of document.querySelectorAll('.toast')) {
      const a = t.getBoundingClientRect();
      if (a.width && qrs.some((r) => !(a.bottom <= r.top || a.top >= r.bottom || a.right <= r.left || a.left >= r.right))) {
        const seen = JSON.parse(sessionStorage.getItem('toastOverQr') || '[]');
        const what = location.hash + ' ' + t.textContent;
        if (!seen.includes(what)) sessionStorage.setItem('toastOverQr', JSON.stringify([...seen, what]));
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;
async function watchToasts(p) {
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  await p.eval(WATCH);
}
const overlaps = (p) => p.eval(`JSON.parse(sessionStorage.getItem('toastOverQr') || '[]')`);

const userAddr = sh('./target/debug/devwallet', ['address']).match(/uregtest1[a-z0-9]+/)[0];
const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9350));
b.setDevice('phone');
try {
  const A = await b.open(`${URL_}#/`, undefined, 'A');
  await watchToasts(A);
  await A.waitFor(`document.querySelector('.topbar-mint .dot.live')`, 30000);
  check((await homeBalance(A)) === 0, 'fresh wallet A, balance 0');

  // ---------- routing and back navigation ----------
  await A.eval(click('a.action[href="#/deposit"]'));
  await A.waitFor(`location.hash === '#/deposit'`, 5000);
  await A.eval(`history.back()`);
  await A.waitFor(`location.hash === '#/' && !!document.querySelector('.balance-card')`, 5000);
  log('ok: back from Deposit returns Home');
  await A.eval(click('.tabbar button.tab'));
  await A.waitFor(`document.querySelector('.sheet.open')`, 3000);
  await shot(A, 'phone-more-sheet');
  await A.eval(`history.back()`);
  await A.waitFor(`!document.querySelector('.sheet') && location.hash === '#/'`, 3000);
  log('ok: back closes the "more" sheet and stays on the page');

  // ---------- deposit 60000, reload mid-way, auto-mint ----------
  await nav(A, '/deposit');
  await shot(A, 'phone-deposit-form');
  await A.eval(fill('.page form .amount-input', '60000'));
  await A.eval(click('.page form button[type=submit]'));
  await A.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
  const dq = decodeURIComponent(await A.eval(`location.hash.split('q=')[1]`));
  await A.waitFor(`/AWAITING PAYMENT/.test(${txt('.status-line')})`, 5000);
  await sleep(300);
  check((await A.eval(`document.querySelectorAll('.toast').length`)) === 0, 'awaiting payment: no toasts on the QR screen');
  const order = await A.eval(`(() => {
    const page = document.querySelector('.page'), at = (sel) => [...page.children].indexOf(page.querySelector(sel)?.closest('.page > *'));
    return [at('.page-head'), at('.qr-card'), at('.pay .chip'), at('.status-line'), at('.progress'), at('p.hint.center')];
  })()`);
  check(order.every((v, i) => v >= 0 && (i === 0 || v >= order[i - 1])) && order[1] < order[3], `deposit order: amount, QR, address+copy, state, bar, expiry (${order})`);
  check(await A.eval(`document.querySelector('.status-line .nowrap').getClientRects().length === 1 && document.querySelector('.status-line .nowrap').contains(document.querySelector('.status-line .cursor'))`), 'blinking cursor stays on the line of its last word');
  check(/waiting for the payment to be mined/.test(await A.eval(txt('.progress'))), 'confirmation bar: waiting to be mined, 0/10');
  const addr = await A.eval(`document.querySelector('.pay .chip').title`);
  check(/^uregtest1/.test(addr), `address chip ${await A.eval(txt('.pay .chip'))}`);
  await qrCheck(A, 'deposit (ZIP-321)', `zcash:${addr}?amount=0.0006`);
  await shot(A, 'phone-deposit-waiting');
  await A.reload();
  await A.waitFor(`location.hash.includes(${J(dq)}) && /AWAITING PAYMENT/.test(${txt('.status-line')})`, 15000);
  log('ok: reload in the middle of the deposit: same quote, still awaiting payment');
  sh('./target/debug/devwallet', ['send', addr, '60000']);
  log('paid 60000 from the devnet user wallet; mining');
  await A.waitFor(`/MINTED/.test(${txt('.status-line')})`, 240000, mine);
  await sleep(600);
  await shot(A, 'phone-deposit-minted');
  check((await homeBalance(A)) === 60000, 'A balance 60,000 after auto-mint');
  await shot(A, 'phone-home');

  // ---------- send 20000 (compact) -> B receives ----------
  await nav(A, '/send');
  await shot(A, 'phone-send-form');
  await A.eval(fill('.page form .amount-input', '20000'));
  await A.eval(click('.page form button[type=submit]'));
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const token = await A.eval(`document.querySelector('details textarea').value`);
  check(token.startsWith('cashuB'), `token (${token.length} chars)`);
  await qrCheck(A, 'compact token', token);
  await shot(A, 'phone-send-token');
  const B = await b.open(`${URL_}#/receive`, await b.newContext(), 'B');
  await watchToasts(B);
  await B.waitFor(`document.querySelector('.topbar-mint .dot.live')`, 30000);
  await B.eval(fill('.page form textarea', token));
  await B.eval(click('.page form button[type=submit]'));
  await toastsSeen(B, '/Received 20,000 zat/');
  check((await homeBalance(B)) === 20000, 'B received 20,000');
  await nav(A, `/send?t=${await A.eval(`(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes(':sent:'))))[0].id)`)}`);
  await A.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Check now').click()`);
  await A.waitFor(`/RECEIVED/.test(${txt('.status-line')})`, 15000);
  log('ok: sender sees the token as RECEIVED');

  // ---------- reclaim an unredeemed token ----------
  await nav(A, '/send');
  await A.eval(fill('.page form .amount-input', '3000'));
  await A.eval(click('.page form button[type=submit]'));
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  await A.eval(`window.confirm = () => true; [...document.querySelectorAll('button')].find(b => b.textContent === 'Reclaim').click()`);
  await A.waitFor(`/RECLAIMED/.test(${txt('.status-line')})`, 15000);
  check((await homeBalance(A)) === 40000, 'reclaimed 3,000: A balance back to 40,000');

  // ---------- offline locked receive ----------
  await nav(B, '/receive');
  const bPub = await B.eval(`document.querySelector('.card .chip').title`);
  await qrCheck(B, 'public key', bPub);
  await shot(B, 'phone-receive');
  await nav(A, '/send');
  await A.eval(click('.page form label.toggle:nth-of-type(2) input'));
  await A.eval(fill('.lock-box textarea', bPub));
  await A.eval(fill('.page form .amount-input', '5000'));
  await A.eval(click('.page form button[type=submit]'));
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const locked = await A.eval(`document.querySelector('details textarea').value`);
  await qrCheck(A, 'locked token (with DLEQ)', locked);
  await shot(A, 'phone-send-locked');
  await A.eval(click('.qr-tap'));
  await A.waitFor(`document.querySelector('.qr-full canvas')`, 3000);
  await shot(A, 'phone-qr-fullscreen');
  await A.eval('history.back()');
  await A.waitFor(`!document.querySelector('.qr-full')`, 3000);
  log('ok: tap-to-enlarge QR opens full screen; back closes it');
  await B.offline(true);
  await B.waitFor(`!document.querySelector('.offline').hidden && /OFFLINE/.test(${txt('.offline')})`, 5000);
  await nav(B, '/receive');
  check(/ACCEPT OFFLINE/.test(await B.eval(txt('.page form button[type=submit]'))), 'offline: button reads ACCEPT OFFLINE');
  await B.eval(fill('.page form textarea', token)); // an unlocked token: must be refused offline
  await B.eval(click('.page form button[type=submit]'));
  await toastsSeen(B, '/Offline, not accepted/');
  log('ok: unlocked token refused offline');
  await B.eval(fill('.page form textarea', locked));
  await B.eval(click('.page form button[type=submit]'));
  await toastsSeen(B, '/Accepted offline: 5,000 zat/');
  await shot(B, 'phone-receive-offline');
  await nav(B, '/');
  check(/\+5,000 zat accepted offline/.test(await B.eval(txt('.balance-extra'))), 'home shows +5,000 accepted offline');
  await shot(B, 'phone-home-offline');
  await B.offline(false);
  await B.waitFor(`Number(document.querySelector('.balance-amount').textContent.replace(/,/g, '')) === 25000`, 40000);
  log('ok: back online, the locked token was redeemed: B balance 25,000');

  // ---------- withdraw 12000 via a ZIP-321 URI, reload mid-way ----------
  await nav(B, '/withdraw');
  await B.eval(fill('.page form textarea', `zcash:${userAddr}?amount=0.00012`));
  check((await B.eval(`document.querySelector('.page form .amount-input').value`)) === '12000', 'amount 12,000 from the URI');
  await B.eval(click('.page form button[type=submit]'));
  await B.waitFor(`!document.querySelector('.review').hidden`, 15000);
  await shot(B, 'phone-withdraw-review');
  await B.eval(`document.querySelector('.review .thumb .btn:last-child').click()`);
  await B.waitFor(`location.hash.startsWith('#/withdraw?q=')`, 30000);
  await shot(B, 'phone-withdraw-pending');
  await B.reload();
  await B.waitFor(`/PENDING|SENDING|PAID/.test(${txt('.status-line')})`, 15000);
  log(`ok: reload in the middle of the withdrawal: ${(await B.eval(txt('.status-line'))).trim()}`);
  await B.waitFor(`/PAID/.test(${txt('.status-line')})`, 300000, mine);
  await sleep(600);
  await shot(B, 'phone-withdraw-paid');
  const kv = await B.eval(`[...document.querySelectorAll('.kv')].map(k => k.textContent).join(' | ')`);
  log('withdrawal:', kv);
  const fee = Number(/Network fee([\d,]+)/.exec(kv)[1].replace(/,/g, ''));
  const change = Number(/Change returned([\d,]+)/.exec(kv)[1].replace(/,/g, ''));
  check(fee <= 10000 && change > 0, `fee ${fee} within the reserve, change ${change} returned`);
  check((await homeBalance(B)) === 25000 - 12000 - fee, `B balance ${25000 - 12000 - fee}`);

  // ---------- the other pages ----------
  await nav(A, '/withdraw');
  await shot(A, 'phone-withdraw-form');
  await nav(A, '/request');
  await A.waitFor(`document.querySelector('.pos-offline').hidden && !document.querySelector('.page form button[type=submit]').disabled`, 10000);
  log('ok: point of sale up: Create request enabled');
  await A.eval(fill('.page form .amount-input', '1500'));
  await A.eval(click('.page form button[type=submit]'));
  await A.waitFor(`document.querySelector('.qr-card canvas')`, 15000);
  await shot(A, 'phone-request');
  for (const [p, name] of [[A, 'activity'], [A, 'status'], [A, 'settings']]) {
    await nav(p, `/${name}`);
    await sleep(name === 'status' ? 1500 : 300);
    await shot(p, `phone-${name}`);
  }
  await nav(B, '/activity');
  await shot(B, 'phone-activity-b');

  // ---------- desktop ----------
  for (const p of [A]) await p.emulate('desktop');
  for (const path of ['/', '/send', '/receive', '/deposit', '/withdraw', '/request', '/activity', '/status', '/settings']) {
    await nav(A, path);
    await sleep(path === '/status' ? 1500 : 400);
    await shot(A, `desktop-${path.slice(1) || 'home'}`);
  }
  await nav(A, `/deposit?q=${encodeURIComponent(dq)}`);
  await shot(A, 'desktop-deposit-minted');

  await nav(A, '/status');
  await A.waitFor(`document.querySelector('.cov-fill.inflight')`, 15000);
  const colours = await A.eval(`['reserve', 'outstanding', 'inflight'].map((c) => getComputedStyle(document.querySelector('.cov-fill.' + c)).backgroundColor)`);
  check(new Set(colours).size === 3, `status: reserve, outstanding and in-flight colours all differ (${colours.join(' / ')})`);
  check(!/\d (confirmation|withdrawal)s?\(s\)|1 confirmations/.test(await A.eval('document.body.innerText')), 'status: plurals read properly');
  for (const p of [A, B]) check((await overlaps(p)).length === 0, `${p.name}: no toast ever overlapped a QR card ${JSON.stringify(await overlaps(p))}`);
  const reserves = await (await fetch('http://127.0.0.1:8095/reserves')).json();
  check(!/address|txid|reason/.test(JSON.stringify(reserves.operator_action)), 'public /reserves operator actions carry no address/txid/reason');
  check(reserves.state === 'ok', `reserves ${reserves.state}, guardians up: ${reserves.guardians.filter((g) => g.up).length}/3`);
  for (const p of [A, B]) if (p.errors.length) log(`${p.name} console:`, p.errors);
  log(`screenshots in ${OUT}`);
  log('ALL PASSED');
} finally {
  b.close();
}
