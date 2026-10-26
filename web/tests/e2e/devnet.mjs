// Devnet browser test of the whole wallet, as two phones (360x780, touch) in headless Chrome,
// driven by taps and by scanning each other's screens (a fake camera fed the other page's QR):
// first run, add money (reload mid-way), send by showing a code, take a code back, receive
// offline (locked to this phone) and a refusal while offline, ask for an amount and pay it,
// cash out from a scanned payment link (reload mid-way), the universal Scan's routing, old
// routes, plain words on every page, and screenshots of every page on a phone and a desktop
// (each phone screen also passes the accessibility check of tests/e2e/audit.mjs).
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
import { J, a11y, balance, fakeCamera, getStarted, nav, overlaps, pointCamera, qrCheck, shooter, sleep, tap, text, type, watchToasts } from './ui.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const URL_ = `https://${HOST}:5173/`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-e2e-'));
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
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
const photo = shooter(OUT, results);
/** A screenshot; on a phone also the accessibility check of that screen (contrast, 44 px, labels). */
const shot = async (p, name, full) => {
  await photo(p, name, full);
  if (name.startsWith('phone-') && name !== 'phone-qr-fullscreen') await a11y(p, check, name.slice(6));
};
const result = (p) => p.eval(`document.querySelector('.result-title')?.textContent ?? ''`);
const waitResult = (p, re, timeout = 20000, tick) => p.waitFor(`${re}.test(document.querySelector('.result-title')?.textContent ?? '')`, timeout, tick);

/** Main-UI words that belong only in Details (the Status page's lead sentence names the mint by design). */
const JARGON = /\b(mint|minted|token|tokens|ecash|proofs?|melt|quote|DLEQ|P2PK|NUT-?\d*)\b/i;
const jargon = (p) =>
  p.eval(`(() => {
    const m = document.querySelector('main').cloneNode(true);
    m.querySelectorAll('details, .status-page > .lead, textarea').forEach((e) => e.remove());
    const t = m.innerText + ' ' + [...document.querySelectorAll('.tabbar, .netbar, .offline, .toasts')].map((e) => e.innerText).join(' ');
    const hit = t.match(${JARGON});
    return hit ? hit[0] + ' in "' + t.slice(Math.max(0, hit.index - 40), hit.index + 40).replace(/\\s+/g, ' ') + '"' : '';
  })()`);

const userAddr = sh('./target/debug/devwallet', ['address']).match(/uregtest1[a-z0-9]+/)[0];
const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9350));
b.setDevice('phone');
try {
  const A = await b.open(`${URL_}#/`, undefined, 'A');
  await watchToasts(A);
  await fakeCamera(A);

  // ---------- first run ----------
  await A.waitFor(`location.hash === '#/welcome'`, 15000);
  await shot(A, 'phone-welcome', true);
  check((await text(A)).includes('Your money lives on this device'), 'first run: welcome cards, backup offered');
  await getStarted(A);
  await A.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  check(/Add money to get started/.test(await text(A)) && (await balance(A)) === 0, 'fresh wallet: empty state "Add money to get started", balance 0');
  await shot(A, 'phone-home-empty');
  check((await A.eval(`[...document.querySelectorAll('.tabbar a')].map((a) => a.textContent).join(',')`)) === 'Home,Send,Scan,Receive,Activity', 'tab bar: Home · Send · Scan · Receive · Activity');
  check(await A.eval(`(() => { const s = document.querySelector('.tabbar .tab.primary .tab-icon').getBoundingClientRect(), o = document.querySelector('.tabbar a[data-path="/send"] svg').getBoundingClientRect(); return s.width > o.width * 2; })()`), 'Scan is the large centre button');

  // ---------- routing and back ----------
  await tap(A, { text: /^Add money$/ });
  await A.waitFor(`location.hash === '#/deposit'`, 5000);
  await tap(A, '.page-head .back');
  await A.waitFor(`location.hash === '#/' && !!document.querySelector('.balance-card')`, 5000);
  log('ok: back from Add money returns Home');
  await nav(A, '/request?r=nope');
  check((await A.eval('location.hash')) === '#/receive?r=nope', 'old route #/request redirects to #/receive, keeping its parameters');

  // ---------- add money 0.0006 ZEC, reload mid-way ----------
  await nav(A, '/');
  await tap(A, { text: /^Add money$/ });
  await shot(A, 'phone-add-money');
  await type(A, null, '0.0006'); // the amount field has focus
  check(/= 60,000 zats/.test(await text(A)), 'amount typed in ZEC shows zats underneath');
  await tap(A, { text: /^Get address$/ });
  await A.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
  const dq = decodeURIComponent(await A.eval(`location.hash.split('q=')[1]`));
  await A.waitFor(`/Waiting for your payment/.test(document.querySelector('.status-line')?.textContent)`, 5000);
  await sleep(300);
  check((await A.eval(`document.querySelectorAll('.toast').length`)) === 0, 'waiting for payment: no toasts on the QR screen');
  const order = await A.eval(`(() => { const all = [...document.querySelectorAll('main *')]; return ['.code-money', '.qr-card', '.pay .chip', '.status-line', 'p.hint.center'].map((s) => all.indexOf(document.querySelector(s))); })()`);
  check(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `add money order: amount, QR, address+copy, state, deadline (${order})`);
  check(/Send exactly/.test(await text(A)) && /0\.0006 ZEC/.test(await text(A)) && /60,000 zats/.test(await text(A)), 'shows "Send exactly 0.0006 ZEC / 60,000 zats"');
  const addr = await A.eval(`document.querySelector('.pay .chip').title`);
  await qrCheck(A, check, 'add money (ZIP-321)', `zcash:${addr}?amount=0.0006`);
  await shot(A, 'phone-add-money-waiting');
  await A.reload();
  await A.waitFor(`location.hash.includes(${J(dq)}) && /Waiting for your payment/.test(document.querySelector('.status-line')?.textContent)`, 15000);
  log('ok: reload in the middle of adding money: same address, still waiting');
  sh('./target/debug/devwallet', ['send', addr, '60000']);
  log('paid 60000 zats from the devnet user wallet; mining');
  await A.waitFor(`/Payment seen|Confirmed/.test(document.querySelector('.status-line')?.textContent ?? '') || !!document.querySelector('.result')`, 240000, mine);
  if (!(await A.eval(`!!document.querySelector('.result')`))) await shot(A, 'phone-add-money-confirming');
  await waitResult(A, /Added/, 240000, mine);
  await sleep(600);
  await shot(A, 'phone-add-money-added');
  check(/\+0\.0006 ZEC/.test(await text(A)) && !!(await A.eval(`document.querySelector('.result .nudge')`)), 'big "Added +0.0006 ZEC", with the backup reminder');
  check((await balance(A)) === 60000, 'A balance 60,000 zats');
  check(/Back it up so you can’t lose it/.test(await text(A)), 'Home: backup reminder after the first money arrives');
  await shot(A, 'phone-home');

  // ---------- send by showing a code; B takes it with the universal Scan ----------
  await tap(A, '.tabbar a[data-path="/send"]');
  await shot(A, 'phone-send');
  await tap(A, { text: /^Show a code$/ });
  await type(A, null, '0.0002');
  await tap(A, { text: /^Show code$/ });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const token = await A.eval(`document.querySelector('.details textarea').value`);
  check(token.startsWith('cashuB') && /compact/.test(await A.eval(`document.querySelector('.details').textContent`)), `unlocked code is compact automatically (${token.length} chars)`);
  check(/Anyone who scans this can take the money, like handing over cash\./.test(await text(A)) && /Waiting for them to scan/.test(await text(A)), 'shown code: the "like handing over cash" line, waiting for them to scan');
  await qrCheck(A, check, 'compact code', token);
  await shot(A, 'phone-send-code');
  const B = await b.open(`${URL_}#/`, await b.newContext(), 'B');
  await watchToasts(B);
  await fakeCamera(B);
  await getStarted(B);
  await B.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  await pointCamera(B, { from: A });
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`/Money for you/.test(document.querySelector('main').textContent)`, 15000);
  check(/\+0\.0002 ZEC/.test(await text(B)), 'Scan read A’s screen: "Money for you +0.0002 ZEC"');
  await shot(B, 'phone-scan-money-for-you');
  await tap(B, { text: /^Receive$/, sel: '.confirm button' });
  await waitResult(B, /Received/, 20000);
  await shot(B, 'phone-received');
  check((await balance(B)) === 20000, 'B received 20,000 zats');
  await waitResult(A, /Picked up/, 15000);
  await shot(A, 'phone-send-picked-up');
  log('ok: A’s screen noticed by itself: "Picked up"');

  // ---------- cancel and take it back ----------
  await nav(A, '/send');
  await tap(A, { text: /^Show a code$/ });
  await type(A, null, '0.00003');
  await tap(A, { text: /^Show code$/ });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  await tap(A, { text: /^Cancel and take it back$/ });
  await shot(A, 'phone-send-take-back-confirm');
  await tap(A, { text: /^Yes, take it back$/ });
  await waitResult(A, /Taken back/, 15000);
  check((await balance(A)) === 40000, 'took 3,000 back after confirming: A balance 40,000');

  // ---------- offline: B shows its code, A sends locked to it, B scans A's code back ----------
  await B.offline(true);
  await B.waitFor(`!document.querySelector('.offline').hidden && /Offline/.test(document.querySelector('.offline').textContent)`, 5000);
  await nav(B, '/receive');
  await shot(B, 'phone-receive');
  await tap(B, { text: /^Show my code$/ });
  const bPub = await B.eval(`document.querySelector('.details .chip').title`);
  check(/You’re offline\. They scan this, then show you a code back/.test(await text(B)), 'offline "Show my code": the receive-key QR and one line on what happens next');
  await qrCheck(B, check, 'receive key', bPub);
  await shot(B, 'phone-receive-offline-code');
  // an unlocked code can't be checked offline: refused, in plain words
  await nav(A, '/send');
  await tap(A, { text: /^Show a code$/ });
  await type(A, null, '0.00001');
  await tap(A, { text: /^Show code$/ });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  await pointCamera(B, { from: A });
  await tap(B, { text: /^Scan their code$/ });
  await waitResult(B, /Couldn’t receive/, 15000);
  check(/You’re offline.*show them your code first/.test(await text(B)), 'offline: an unlocked code is refused, saying what to do instead');
  await shot(B, 'phone-receive-refused-offline');
  await tap(A, { text: /^Cancel and take it back$/ });
  await tap(A, { text: /^Yes, take it back$/ });
  await waitResult(A, /Taken back/, 15000);
  // A scans B's code and sends 0.00005 ZEC locked to it
  await tap(B, '.tabbar a[data-path="/receive"]');
  await tap(B, { text: /^Show my code$/ });
  await pointCamera(A, { from: B });
  await nav(A, '/send');
  await tap(A, { text: /^Scan their code$/ });
  await A.waitFor(`/Send to this person/.test(document.querySelector('main').textContent)`, 15000);
  check(/Only they can take this money\. You can’t take it back\./.test(await text(A)), 'scanned a receive code: "Send to this person", with the can’t-take-it-back warning');
  await type(A, null, '0.00005');
  await shot(A, 'phone-send-to-person');
  await tap(A, { text: /^Send$/, sel: '.confirm button' });
  await A.waitFor(`location.hash.startsWith('#/send?t=')`, 15000);
  const locked = await A.eval(`document.querySelector('.details textarea').value`);
  check(/locked/.test(await A.eval(`document.querySelector('.details').textContent`)) && !/Cancel and take it back/.test(await text(A)), 'locked code: with DLEQ proofs, no take-back');
  await qrCheck(A, check, 'locked code (with DLEQ)', locked);
  await shot(A, 'phone-send-locked');
  await tap(A, '.qr-tap');
  await A.waitFor(`document.querySelector('.qr-full canvas')`, 3000);
  await shot(A, 'phone-qr-fullscreen');
  await A.eval('history.back()');
  await A.waitFor(`!document.querySelector('.qr-full')`, 3000);
  log('ok: tap-to-enlarge QR opens full screen; back closes it');
  await pointCamera(B, { from: A });
  await tap(B, { text: /^Scan their code$/ });
  await waitResult(B, /Received/, 20000);
  check(/Received offline/.test(await text(B)), 'B, offline, received the locked code: "Received offline…"');
  await shot(B, 'phone-received-offline');
  await nav(B, '/');
  check(/\+0\.00005 ZEC received offline/.test(await text(B)), 'Home: +0.00005 ZEC received offline');
  await shot(B, 'phone-home-offline');
  await B.offline(false);
  await B.waitFor(`/25,000 zats/.test(document.querySelector('.money.balance')?.textContent ?? '')`, 40000);
  log('ok: back online, confirmed by itself: B balance 25,000 zats');

  // ---------- A asks for 0.000015 ZEC; B pays it from the universal Scan ----------
  await nav(A, '/receive');
  await tap(A, { text: /^Show my code$/ });
  await shot(A, 'phone-receive-amount');
  await type(A, null, '0.000015');
  await tap(A, { text: /^Show code$/ });
  await A.waitFor(`location.hash.startsWith('#/receive?r=')`, 15000);
  await A.waitFor(`/Waiting for payment/.test(document.querySelector('.status-line')?.textContent ?? '')`, 10000);
  const creq = await A.eval(`(() => { const c = document.querySelector('.qr-card canvas'); return c && c.getAttribute('aria-label'); })()`);
  check(/0\.000015 ZEC/.test(creq), `payment code QR: ${creq}`);
  await shot(A, 'phone-receive-code');
  await pointCamera(B, { from: A });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`/Pay this code/.test(document.querySelector('main').textContent)`, 15000);
  await shot(B, 'phone-scan-pay');
  await tap(B, { text: /^Pay 0\.000015 ZEC$/ });
  await waitResult(B, /Paid/, 20000);
  await shot(B, 'phone-paid');
  await waitResult(A, /Received/, 30000);
  await shot(A, 'phone-receive-received');
  check((await balance(A)) === 36500 && (await balance(B)) === 23500, 'A received 1,500 (36,500), B paid it (23,500)');

  // ---------- universal Scan: unknown code; paste instead ----------
  await pointCamera(B, { text: 'https://example.com/not-money' });
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`/This code isn’t something this wallet understands\./.test(document.querySelector('main').textContent)`, 15000);
  await shot(B, 'phone-scan-unknown');
  await tap(B, { text: /^Paste instead$/, sel: 'main .link-btn' });
  await B.eval(`(() => { const t = document.querySelector('.paste-box textarea'); t.value = ${J(`zcash:${userAddr}?amount=0.00012`)}; })()`);
  await tap(B, { text: /^Continue$/ });
  await B.waitFor(`location.hash === '#/withdraw'`, 5000);
  log('ok: a pasted payment link goes to Cash out');

  // ---------- cash out from a scanned payment link, reload mid-way ----------
  await pointCamera(B, { text: `zcash:${userAddr}?amount=0.00012` });
  await nav(B, '/');
  await tap(B, '.tabbar a[data-path="/scan"]');
  await B.waitFor(`location.hash === '#/withdraw' && document.querySelector('textarea').value.startsWith('zcash:')`, 15000);
  check((await B.eval(`document.querySelector('.amount-input').value`)) === '0.00012', 'scanned payment link: Cash out prefilled with the address and 0.00012 ZEC');
  await shot(B, 'phone-cash-out');
  await tap(B, { text: /^Review$/ });
  await B.waitFor(`!document.querySelector('.review').hidden`, 15000);
  await shot(B, 'phone-cash-out-review');
  await tap(B, '.review .btn.confirm');
  await B.waitFor(`location.hash.startsWith('#/withdraw?q=')`, 30000);
  await shot(B, 'phone-cash-out-sending');
  await B.reload();
  await B.waitFor(`/Sending/.test(document.querySelector('main').textContent) || !!document.querySelector('.result')`, 15000);
  log('ok: reload in the middle of cashing out');
  await waitResult(B, /Sent/, 300000, mine);
  await sleep(600);
  await shot(B, 'phone-cash-out-sent');
  const kv = await B.eval(`[...document.querySelectorAll('.details .kv')].map((k) => k.textContent).join(' | ')`);
  log('cash out:', kv);
  const zats = (label) => Math.round(Number(new RegExp(`${label}([\\d.]+) ZEC`).exec(kv)[1]) * 1e8);
  const fee = zats('Network fee');
  const change = zats('Change returned');
  check(fee <= 10000 && change > 0, `fee ${fee} within the reserve, change ${change} returned`);
  check((await balance(B)) === 23500 - 12000 - fee, `B balance ${23500 - 12000 - fee}`);

  // ---------- status, settings, activity ----------
  await nav(A, '/');
  await A.waitFor(`/Backed \\d+% · 3\\/3 keyholders/.test(document.querySelector('.backing-chip').textContent)`, 15000);
  log(`ok: Home chip: ${await A.eval(`document.querySelector('.backing-chip').textContent`)}`);
  await tap(A, '.backing-chip');
  await A.waitFor(`/Fully backed/.test(document.querySelector('.backing')?.textContent ?? '')`, 15000);
  check((await A.eval(`document.querySelectorAll('.guardian.up').length`)) === 3 && /Any two must approve every cash-out/.test(await text(A)), 'Status: Fully backed, the bar, three keyholders online');
  await shot(A, 'phone-status', true);
  await tap(A, { text: /^Details$/, sel: 'summary' });
  check(/FROST guardians/.test(await text(A)) && /Chain height/.test(await text(A)), 'Status Details: guardians, chain height, issued/redeemed');
  await shot(A, 'phone-status-details', true);
  await nav(A, '/');
  await tap(A, '.home-top a[aria-label="Settings"]');
  await shot(A, 'phone-settings', true);
  await tap(A, { text: /Show zats first/, sel: 'label.toggle' });
  await nav(A, '/');
  check(/^36,500 zats/.test(await A.eval(`document.querySelector('.money.balance .m-main').textContent`)), 'Settings → Show zats first: Home reads 36,500 zats');
  await shot(A, 'phone-home-zats-first');
  await nav(A, '/settings');
  await tap(A, { text: /Show zats first/, sel: 'label.toggle' });
  await nav(A, '/activity');
  await shot(A, 'phone-activity', true);
  await nav(B, '/activity');
  await shot(B, 'phone-activity-b', true);

  // ---------- plain words on every page ----------
  await A.eval('window.__setCamera(null)');
  for (const path of ['/welcome', '/', '/send', '/scan', '/receive', '/activity', '/deposit', '/withdraw', '/status', '/settings', `/deposit?q=${dq}`]) {
    await nav(A, path);
    if (path === '/scan') await A.eval(`history.back()`).then(() => sleep(300)); // close the camera
    await sleep(path === '/status' ? 1200 : 300);
    const hit = await jargon(A);
    check(!hit, `plain words on ${path}${hit ? `: ${hit}` : ''}`);
  }

  // ---------- desktop ----------
  await A.emulate('desktop');
  for (const path of ['/', '/send', '/receive', '/activity', '/deposit', '/withdraw', '/status', '/settings']) {
    await nav(A, path);
    await sleep(path === '/status' ? 1500 : 400);
    await shot(A, `desktop-${path.slice(1) || 'home'}`);
  }

  for (const p of [A, B]) check((await overlaps(p)).length === 0, `${p.name}: no toast ever overlapped a QR code ${JSON.stringify(await overlaps(p))}`);
  const reserves = await (await fetch('http://127.0.0.1:8095/reserves')).json();
  check(!/address|txid|reason/.test(JSON.stringify(reserves.operator_action)), 'public /reserves operator actions carry no address/txid/reason');
  check(reserves.state === 'ok', `reserves ${reserves.state}, guardians up: ${reserves.guardians.filter((g) => g.up).length}/3`);
  for (const p of [A, B]) if (p.errors.length) log(`${p.name} console:`, p.errors);
  log(`screenshots in ${OUT}`);
  log('ALL PASSED');
} finally {
  b.close();
}
