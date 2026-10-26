// Helpers for the devnet browser tests: real taps (CDP touch events at the element's centre, only
// if it is visible and on top), typing, a fake camera that shows the scanner a QR image (so scans
// go through the wallet's real decoder), QR checks, and screenshots.
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
export { sleep, J };

/** Finds `target` in the page: a CSS selector, or { text: /re/, sel? } matching an element's text. */
const finder = (target) =>
  typeof target === 'string'
    ? `document.querySelector(${J(target)})`
    : `[...document.querySelectorAll(${J(target.sel ?? 'button, a, label, summary, [role=switch]')})].filter((e) => e.getClientRects().length && !e.closest('[hidden]')).find((e) => new RegExp(${J(target.text.source)}, ${J(target.text.flags)}).test(e.textContent.trim()))`;

/** Taps it like a finger: scrolls it into view, checks nothing covers it, touches its centre. */
export async function tap(p, target, timeout = 15000) {
  const where = await p.waitFor(
    `(() => {
      const e = ${finder(target)};
      if (!e || e.disabled) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return top && (e === top || e.contains(top) || top.contains(e) && top.tagName === 'LABEL') ? { x, y } : null;
    })()`,
    timeout,
  );
  for (const type of ['touchStart', 'touchEnd']) {
    await p.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: where.x, y: where.y }] });
  }
  p.taps = (p.taps ?? 0) + 1;
  await sleep(250);
}

/** Types into the focused field (or taps `target` first, counted as a tap). */
export async function type(p, target, text) {
  if (target) await tap(p, target);
  await p.send('Input.insertText', { text });
  p.typed = (p.typed ?? 0) + 1;
  await sleep(150);
}

export const FAKE_CAMERA = `(() => {
  if (window.__setCamera || !navigator.mediaDevices) return;
  const cv = document.createElement('canvas'); cv.width = 960; cv.height = 960;
  const c = cv.getContext('2d');
  let img = null;
  window.__setCamera = (url) => new Promise((r) => { if (!url) { img = null; return r(); } const i = new Image(); i.onload = () => { img = i; r(); }; i.src = url; });
  setInterval(() => { c.fillStyle = '#8a8680'; c.fillRect(0, 0, 960, 960); if (img) c.drawImage(img, 120, 120, 720, 720); }, 50);
  navigator.mediaDevices.getUserMedia = async () => cv.captureStream(15);
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'fake back camera', groupId: '' }];
})()`;

export async function fakeCamera(p) {
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_CAMERA });
  await p.eval(FAKE_CAMERA);
}

/** What the fake camera of `p` sees: the QR code on `from`'s screen, or a QR of `text`. */
export async function pointCamera(p, { from, text }) {
  const url = from
    ? await from.eval(`document.querySelector('.qr-card canvas').toDataURL()`)
    : await p.eval(`(async () => { const { default: QR } = await import('/node_modules/.vite/deps/qrcode.js'); return QR.toDataURL(${J(text)}, { margin: 4, scale: 8 }); })()`);
  await p.eval(`window.__setCamera(${J(url)})`);
}

/**
 * The QR on the page must decode back to exactly `expect`: straight from the canvas, and from a
 * camera-sized frame (1080 px, light noise) decoded at 800 px like the wallet's own scanner.
 */
export async function qrCheck(p, check, label, expect) {
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
  check(r.direct === expect && r.camera === expect && r.bg === 'rgb(255, 255, 255)', `QR ${label}: ${r.modules} modules, white card, decodes to the exact ${expect.length}-char text (direct and camera-sized)`);
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
export async function watchToasts(p) {
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  await p.eval(WATCH);
}
export const overlaps = (p) => p.eval(`JSON.parse(sessionStorage.getItem('toastOverQr') || '[]')`);

export const nav = async (p, path) => {
  await p.eval(`location.hash = ${J(`#${path}`)}`);
  await sleep(500);
};
export const text = (p, sel = 'main') => p.eval(`(document.querySelector(${J(sel)})?.textContent ?? '')`);
/** Balance in zats, from Home (the amount's zats line). */
export async function balance(p) {
  await nav(p, '/');
  return p.eval(`(() => { const m = document.querySelector('.money.balance'); const t = [...m.children].map((e) => e.textContent).find((t) => /zats?$/.test(t)); return Number(t.replace(/[^0-9]/g, '')); })()`);
}
export function shooter(out, list) {
  return async (p, name, full = false) => {
    const file = join(out, `${name}.png`);
    await p.screenshot(file, full);
    list.push(file);
  };
}
/** A fresh wallet past the first-run screen. */
export async function getStarted(p) {
  await p.waitFor(`location.hash === '#/welcome' || !!document.querySelector('.balance-card')`, 15000);
  if (await p.eval(`location.hash === '#/welcome'`)) await tap(p, { text: /^Get started$/ });
  await p.waitFor(`!!document.querySelector('.balance-card')`, 5000);
}

/**
 * Accessibility check of what is on screen: text contrast >= 4.5:1 (3:1 for large text) against
 * the real background, tap targets >= 44 px, every control labelled. Returns the problems.
 */
export const AUDIT = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let bg = { r: 11, g: 12, b: 14, a: 1 };
    for (const c of stack.reverse()) bg = blend(c, bg);
    return bg;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.5 && !el.closest('[hidden],.qr-card,.toasts'); };
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = walker.nextNode()); ) {
    const el = n.parentElement;
    if (!n.textContent.trim() || seen.has(el) || !visible(el) || el.closest('button:disabled')) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const fg = parse(s.color); const bg = bgOf(el);
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const size = parseFloat(s.fontSize); const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) bad.push('contrast ' + ratio.toFixed(2) + ' "' + n.textContent.trim().slice(0, 40) + '"');
  }
  for (const el of document.querySelectorAll('button, a[href], input:not([type=file]), textarea, [role=switch], summary')) {
    if (!visible(el) || el.closest('.side-nav, .sidebar')) continue;
    const r = el.getBoundingClientRect();
    const inText = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
    if (!inText && (r.height < 44 || r.width < 44) && !(el.type === 'checkbox' && el.closest('label'))) bad.push('target ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + el.tagName + ' "' + (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 30) + '"');
    const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent) || el.closest('label')?.textContent;
    if (!name || !name.trim()) bad.push('unlabelled ' + el.tagName + ' ' + el.className);
  }
  return bad;
})()`;

/** Runs AUDIT; any problem fails the test. */
export async function a11y(p, check, label) {
  const bad = await p.eval(AUDIT);
  check(!bad.length, `a11y ${label}${bad.length ? `: ${bad.join('; ')}` : ''}`);
}
