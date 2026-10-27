// Devnet test of the judge kit: `zec-ecash-cli judge-kit create 3`, one link claimed in a fresh
// browser (a phone), every step of the tour there (a second browser as the other device; offline
// mode for "Receive without internet"), `judge-kit status` (1 claimed), `judge-kit reclaim` (the
// other 2 back), and an already-used link. Screenshots at 360 px: the claim screen, the tour and a
// judge's PDF page.
//
//   scripts/devnet-up.sh; cargo build --release -p zec-ecash-cli
//   cd web && npm run e2e:judge          # OUT=<dir> for the screenshots
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { launch } from './cdp.mjs';
import { J, fakeCamera, getStarted, nav, pointCamera, sleep, tap, text, type } from './ui.mjs';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const ORIGIN = `https://${HOST}:5173`;
const OUT = process.env.OUT ?? mkdtempSync(join(tmpdir(), 'zec-ecash-judge-'));
const KIT = join(REPO, 'devnet/judge-kit');
const DL = join(OUT, 'downloads');
mkdirSync(DL, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ZEC_MINT_CA: 'web/certs/rootCA.pem' } });
const cli = (...args) => sh('./target/release/zec-ecash-cli', args);
/** The CLI's output, and whether it succeeded. */
const cliTry = (...args) => {
  try {
    return { ok: true, out: cli(...args) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
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
const shot = async (p, name, full = false) => {
  await sleep(300);
  await p.screenshot(join(OUT, `${name}.png`), full);
};
const result = (re) => `${re}.test(document.querySelector('.result-title')?.textContent ?? '')`;
const zats = (s) => Number(String(s).replace(/[^0-9]/g, ''));
const balance = async (p) => {
  await nav(p, '/activity');
  await nav(p, '/');
  return zats(await p.eval(`document.querySelector('.money.balance .m-main').textContent`));
};
/** Opens the tour and ticks step `id`. */
const tick = async (p, id) => {
  await nav(p, '/judges');
  await p.eval(`(() => { const t = document.getElementById('tour-${id}'); if (!t.checked) t.click(); })()`);
};
/** Taps step `id`'s "Do it". */
const doIt = async (p, id) => {
  await nav(p, '/');
  await nav(p, '/judges');
  await p.eval(`document.querySelector('[data-step="${id}"] .tour-do').click()`);
};

const userAddr = sh('./target/debug/devwallet', ['address']).match(/uregtest1[a-z0-9]+/)[0];
// An earlier run's kit: its unclaimed links go back to the CLI wallet first.
if (existsSync(join(KIT, 'kit.json'))) {
  log(cli('judge-kit', 'reclaim').trim().split('\n').pop());
  rmSync(KIT, { recursive: true });
}

const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-chrome-')), Number(process.env.CDP_PORT ?? 9366));
try {
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  b.setDevice('phone');

  // ---------- the organiser funds the CLI wallet (regtest coins) and makes a kit of 3 ----------
  const F = await b.open(`${ORIGIN}/#/`, undefined, 'organiser');
  await getStarted(F);
  await F.waitFor(`document.querySelector('.netbar .dot.live')`, 30000);
  await nav(F, '/deposit');
  await type(F, null, '80000');
  await tap(F, { text: /^Get address$/ });
  await F.waitFor(`location.hash.startsWith('#/deposit?q=')`, 15000);
  sh('./target/debug/devwallet', ['send', await F.eval(`document.querySelector('.pay .chip').title`), '80000']);
  log('80,000 zats in from the devnet user wallet; mining');
  await F.waitFor(result(/Added/), 240000, mine);
  await nav(F, '/send');
  await tap(F, { text: /^Show a code$/ });
  await type(F, null, '78000');
  await tap(F, { text: /^Show code$/ });
  await F.waitFor(`document.querySelector('.details textarea')`, 15000);
  check(/received 78000/.test(cli('receive', await F.eval(`document.querySelector('.details textarea').value`))), 'the CLI wallet has 78,000 zats for the kit');
  const names = join(OUT, 'names.txt');
  writeFileSync(names, 'Ana Costa\nBen Okafor\nChen Wei\n');
  const short = cliTry('judge-kit', 'create', '3', '1000000', '--names', names);
  check(!short.ok && /not enough ecash for the kit: it needs 3000000 zat/.test(short.out) && !existsSync(join(KIT, 'kit.json')), `create refuses when the balance is short: ${short.out.trim().split('\n').pop()}`);
  const made = cli('judge-kit', 'create', '3', '25000', '--names', names);
  log(made.trim().split('\n').pop());
  const kit = JSON.parse(readFileSync(join(KIT, 'kit.json'), 'utf8')).judges;
  check(kit.length === 3 && kit.every((j) => j.link.startsWith(`${ORIGIN}/#/claim/cashuB`)), '3 links, each <site>/#/claim/<token> (the token in the fragment)');
  const files = readdirSync(KIT).sort();
  check(['kit.csv', 'kit.json', 'judge-01-ana-costa.pdf', 'judge-01-ana-costa.png', 'judge-01-ana-costa.txt', 'judge-03-chen-wei.pdf'].every((f) => files.includes(f)), `files: ${files.join(', ')}`);
  check((statSync(KIT).mode & 0o777) === 0o700 && files.every((f) => (statSync(join(KIT, f)).mode & 0o777) === 0o600), 'judge-kit/ is mode 700 and every file 600');
  const csv = readFileSync(join(KIT, 'kit.csv'), 'utf8').trim().split('\n');
  check(csv[0] === 'name,link,amount,created' && csv.length === 4 && csv[1].startsWith('Ana Costa,https://') && /,25000,20\d\d-\d\d-\d\dT/.test(csv[1]), 'kit.csv: name, link, amount, created');
  const pdf = await PDFDocument.load(readFileSync(join(KIT, 'judge-01-ana-costa.pdf')));
  check(pdf.getPageCount() === 1 && /Ana Costa/.test(pdf.getTitle() ?? ''), 'the judge PDF is a valid one-page PDF');
  execFileSync('sips', ['-s', 'format', 'png', '-Z', '1400', join(KIT, 'judge-01-ana-costa.pdf'), '--out', join(OUT, 'judge-pdf.png')], { stdio: 'ignore' });
  execFileSync('sips', ['-g', 'pixelWidth', join(KIT, 'judge-01-ana-costa.png')], { stdio: 'ignore' }); // a PNG the OS can read
  check(cli('judge-kit', 'status').includes('0 claimed, 3 unclaimed'), 'status: 0 claimed, 3 unclaimed');

  // ---------- the judge: a fresh phone opens link 1 ----------
  const judgeCtx = await b.newContext();
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, browserContextId: judgeCtx, eventsEnabled: true });
  const Jg = await b.open('about:blank', judgeCtx, 'judge');
  await fakeCamera(Jg);
  await Jg.eval(`location.href = ${J(kit[0].link)}`);
  await Jg.waitFor(`/Welcome, judge — claiming 25,000 zats…/.test(document.querySelector('main')?.textContent ?? '') || ${result(/Claimed/)}`, 20000);
  check(!(await Jg.eval(`location.href`)).includes('cashu'), 'the token is out of the address bar straight away');
  await Jg.waitFor(result(/Claimed/), 30000);
  check(/Anyone with this link can claim it\. Don’t share it\./.test(await text(Jg)), 'the claim screen warns once: "Anyone with this link can claim it. Don’t share it."');
  await shot(Jg, 'claim-360', true);
  await Jg.waitFor(`location.hash === '#/judges'`, 10000);
  check(!(await Jg.eval(`sessionStorage.getItem('zec-ecash-claim')`)), 'then the tour opens; nothing of the link is kept');
  check(/25,000/.test(await text(Jg, '.tour-balance')) && /0 of 8 done/.test(await text(Jg, '.tour-progress')), 'tour: 25,000 zats, 0 of 8 done');
  await shot(Jg, 'tour-360', true);

  // 1. balance
  await doIt(Jg, 'balance');
  check((await Jg.eval(`location.hash`)) === '#/' && (await balance(Jg)) === 25000, '1. Home shows 25,000 zats (no first-run screen: the money came first)');
  check(!!(await Jg.eval(`document.querySelector('.nudge')`)), '   …and the backup card comes after');
  await tick(Jg, 'balance');

  // 2. a second device
  const tourQr = await Jg.eval(`(async () => { const { default: Q } = await import('/node_modules/.vite/deps/qr-scanner.js'); return (await Q.scanImage(document.querySelector('[data-step="second"] canvas'), { returnDetailedScanResult: true })).data; })()`);
  check(tourQr === `${ORIGIN}/`, `2. "Open the wallet on another device" QR: ${tourQr}`);
  const D = await b.open(tourQr, await b.newContext(), 'device2');
  await fakeCamera(D);
  await getStarted(D);
  await doIt(Jg, 'second');
  await Jg.waitFor(`location.hash === '#/send?do=show' && document.querySelector('.amount-input')`, 10000);
  await type(Jg, null, '5000');
  await tap(Jg, { text: /^Show code$/ });
  await Jg.waitFor(`document.querySelector('.qr-card canvas')`, 15000);
  await pointCamera(D, { from: Jg });
  await tap(D, '.tabbar a[data-path="/receive"]');
  await tap(D, { text: /^Scan their code$/ });
  await D.waitFor(result(/Received/), 20000);
  await Jg.waitFor(result(/Picked up ✓/), 30000);
  check(true, '2. Send → Show a code (deep link), scanned on the second device: picked up');
  await tick(Jg, 'second');

  // 3. receive without internet
  await Jg.offline(true);
  await doIt(Jg, 'offline');
  await Jg.waitFor(`/They’ll scan this, then show you a code back to scan/.test(document.querySelector('main').textContent)`, 10000);
  await pointCamera(D, { from: Jg });
  await nav(D, '/send');
  await tap(D, { text: /^Send without internet$/ });
  await tap(D, { text: /^Scan their code$/ });
  await D.waitFor(`/Send to this person/.test(document.querySelector('main').textContent)`, 15000);
  await type(D, null, '1000');
  await tap(D, { text: /^Send$/, sel: '.confirm button' });
  await D.waitFor(`/Waiting for them/.test(document.querySelector('.status-line')?.textContent ?? '')`, 15000);
  await pointCamera(Jg, { from: D });
  await tap(Jg, { text: /^Scan their code$/ });
  await Jg.waitFor(result(/Received/), 20000);
  check(/Received offline/.test(await text(Jg)), '3. offline: Receive → Receive without internet (deep link); 1,000 zats received with no internet');
  await Jg.offline(false);
  await Jg.waitFor(`document.querySelector('.offline').hidden`, 30000);
  await tick(Jg, 'offline');

  // 4. ask for an amount
  await doIt(Jg, 'request');
  await Jg.waitFor(`/Request an amount/.test(document.querySelector('.confirm-label')?.textContent ?? '')`, 10000);
  await type(Jg, null, '500');
  await tap(Jg, { text: /^Show code$/ });
  await Jg.waitFor(`location.hash.startsWith('#/receive?r=') && document.querySelector('.qr-card canvas')`, 15000);
  await pointCamera(D, { from: Jg });
  await nav(D, '/');
  await tap(D, '.tabbar a[data-path="/scan"]');
  await tap(D, { text: /^Pay 500 zats$/ });
  await D.waitFor(result(/Paid/), 20000);
  await Jg.waitFor(`/Paid|Received/.test(document.querySelector('main').textContent) && !/Waiting for payment/.test(document.querySelector('.status-line')?.textContent ?? '')`, 30000);
  check(true, '4. Receive → Request an amount (deep link), paid from the second device');
  await tick(Jg, 'request');

  // 5. the demo shop
  await nav(Jg, '/judges');
  await tap(Jg, { text: /Load a demo shop/ });
  await Jg.waitFor(`location.hash === '#/charge' && /Demo Café/.test(document.querySelector('.modebar').textContent) && document.querySelectorAll('.item-btn').length === 2`, 15000);
  check(/Coffee/.test(await text(Jg, '.item-grid')) && /1,500 zats/.test(await text(Jg, '.item-grid')), '5. "Load a demo shop": Demo Café with coffee 1,000 and cake 1,500 zats, at the counter');
  await tap(Jg, { text: /^Coffee/, sel: '.item-btn' });
  await tap(Jg, { text: /^Charge 1,000 zats$/ });
  await Jg.waitFor(`document.querySelector('.customer .qr-card canvas')`, 15000);
  await pointCamera(D, { from: Jg });
  await nav(D, '/');
  await tap(D, '.tabbar a[data-path="/scan"]');
  await tap(D, { text: /^Pay 1,000 zats$/ });
  await Jg.waitFor(`/Paid ✓/.test(document.querySelector('.customer')?.textContent ?? '')`, 30000);
  await nav(Jg, '/invoices');
  await Jg.eval(`[...document.querySelectorAll('.inv-row a')].find((a) => a.textContent === 'INV-0001').click()`);
  await Jg.waitFor(`document.querySelector('.receipt-box canvas')`, 30000);
  // a phone hands PDFs to the share sheet: catch what it is given
  await Jg.eval(`(() => {
    navigator.canShare = () => true;
    navigator.share = async (d) => {
      const bytes = new Uint8Array(await d.files[0].arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      window.__shared = { name: d.files[0].name, type: d.files[0].type, b64: btoa(bin) };
    };
  })()`);
  await tap(Jg, { text: /^Receipt PDF$/ });
  await Jg.waitFor(`window.__shared`, 20000);
  const shared = await Jg.eval(`window.__shared`);
  const got = shared.name;
  writeFileSync(join(DL, got), Buffer.from(shared.b64, 'base64'));
  const receipt = await PDFDocument.load(readFileSync(join(DL, got)));
  check(receipt.getPageCount() === 1 && /INV-0001/.test(got) && shared.type === 'application/pdf', `   …charged a coffee, paid from the second device, receipt PDF exported through the share sheet (${got})`);
  await nav(Jg, '/judges');
  await tap(Jg, { text: /^Leave demo shop$/ });
  await Jg.waitFor(`location.hash === '#/judges' && !document.querySelector('.app').classList.contains('shop-mode') && /Load a demo shop/.test(document.querySelector('[data-step="shop"]').textContent)`, 15000);
  check(true, '   "Leave demo shop": back to the personal wallet, the demo cleared');
  await tick(Jg, 'shop');

  // 6. the backing
  await doIt(Jg, 'status');
  await Jg.waitFor(`location.hash === '#/status' && /keyholders|Held vs owed/i.test(document.querySelector('main').textContent)`, 15000);
  check(true, '6. Check the backing opens Status');
  await tick(Jg, 'status');

  // 7. cash out 10,000 zats
  await doIt(Jg, 'cashout');
  await Jg.waitFor(`location.hash === '#/withdraw'`, 5000);
  await Jg.eval(`(() => { const t = document.querySelector('textarea.input'); t.value = ${J(userAddr)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await type(Jg, '.amount-input', '10000');
  await tap(Jg, { text: /^Review$/ });
  await tap(Jg, '.review .btn.confirm');
  await Jg.waitFor(result(/Sent/), 300000, mine);
  check(true, '7. Cash out 10,000 zats to a Zcash address: sent on chain');
  await tick(Jg, 'cashout');

  // 8. add money
  await doIt(Jg, 'deposit');
  await type(Jg, null, '20000');
  await tap(Jg, { text: /^Get address$/ });
  await Jg.waitFor(`location.hash.startsWith('#/deposit?q=') && document.querySelector('.pay .chip')`, 15000);
  check(/takes about 13 minutes; start it now and carry on/.test(await Jg.eval(`(async () => { location.hash = '#/judges'; await new Promise((r) => setTimeout(r, 400)); return document.querySelector('[data-step="deposit"]').textContent; })()`)), '8. Add money: an address to pay, and the tour says it takes about 13 minutes');
  await tick(Jg, 'deposit');
  await Jg.eval(`location.reload()`);
  await Jg.waitFor(`/8 of 8 done/.test(document.querySelector('.tour-progress')?.textContent ?? '')`, 15000);
  check((await Jg.eval(`document.querySelectorAll('.tour-tick:checked').length`)) === 8, 'every step ticked, kept after a reload');
  check(/What you just saw/.test(await text(Jg)) && (await Jg.eval(`[...document.querySelectorAll('.tour-end a')].map((a) => a.href).join(' ')`)).includes('github.com/guni7/zec-ecash'), 'the end: "What you just saw", the project description and the code');
  await shot(Jg, 'tour-done-360', true);

  // ---------- the organiser: status, reclaim ----------
  const st = cli('judge-kit', 'status');
  check(/1 claimed, 2 unclaimed/.test(st), `status: ${st.trim().split('\n').pop()}`);
  const cliBefore = zats(cli('balance'));
  const rc = cli('judge-kit', 'reclaim');
  check(/took back 2 unclaimed links, 50000 zat/.test(rc) && zats(cli('balance')) === cliBefore + 50000, `reclaim: ${rc.trim().split('\n').pop()}`);
  check(/1 claimed, 0 unclaimed, 0 being claimed, 2 reclaimed/.test(cli('judge-kit', 'status')), 'status after: 1 claimed, 2 reclaimed');

  // ---------- links that were used ----------
  for (const [i, why] of [[0, 'claimed by the judge'], [1, 'reclaimed by the organiser']]) {
    const K = await b.open('about:blank', await b.newContext(), `late${i}`);
    await K.eval(`location.href = ${J(kit[i].link)}`);
    await K.waitFor(`/This link has already been used\\. If that wasn’t you, ask for a new one\\./.test(document.querySelector('main')?.textContent ?? '')`, 30000);
    if (i === 0) await shot(K, 'claim-used-360', true);
    // nothing came in: Home is still the first-run screen of an empty wallet
    await nav(K, '/');
    await K.waitFor(`location.hash === '#/welcome'`, 10000);
    check(true, `an already-used link (${why}): "This link has already been used…", nothing claimed`);
  }
  for (const p of [Jg, D]) if (p.errors.filter((e) => !/vite/.test(e)).length) log(`${p.name} console:`, p.errors.filter((e) => !/vite/.test(e)).slice(0, 5));
  log(`screenshots in ${OUT}`);
  log('ALL PASSED');
} finally {
  b.close();
}
