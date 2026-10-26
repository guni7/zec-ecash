// Accessibility audit of every page on a 360 px phone (devnet web server running):
// text contrast >= 4.5:1 (3:1 for large text) against the real background, tap targets >= 44 px,
// and every control labelled.   node --experimental-websocket tests/e2e/audit.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './cdp.mjs';

const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const PAGES = ['/', '/send', '/receive', '/deposit', '/withdraw', '/request', '/activity', '/status', '/settings'];

const AUDIT = `(() => {
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
  for (const el of document.querySelectorAll('button, a[href], input:not([type=file]), textarea, [role=switch]')) {
    if (!visible(el) || el.closest('.side-nav, .sidebar')) continue;
    const r = el.getBoundingClientRect();
    const inText = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
    if (!inText && (r.height < 44 || r.width < 44) && !(el.type === 'checkbox' && el.closest('label'))) bad.push('target ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + el.tagName + ' "' + (el.textContent || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 30) + '"');
    const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent) || el.closest('label')?.textContent;
    if (!name || !name.trim()) bad.push('unlabelled ' + el.tagName + ' ' + el.className);
  }
  return bad;
})()`;

const b = await launch(mkdtempSync(join(tmpdir(), 'zec-ecash-audit-')), 9352);
b.setDevice('phone');
let total = 0;
try {
  const p = await b.open(`https://${HOST}:5173/#/`, undefined, 'audit');
  await new Promise((r) => setTimeout(r, 2000));
  for (const path of PAGES) {
    await p.eval(`location.hash = '#${path}'`);
    await new Promise((r) => setTimeout(r, path === '/status' ? 1500 : 500));
    const bad = await p.eval(AUDIT);
    total += bad.length;
    console.log(`${path.padEnd(10)} ${bad.length ? bad.length + ' issue(s)' : 'ok'}`);
    for (const x of bad) console.log(`   ${x}`);
  }
} finally {
  b.close();
}
process.exitCode = total ? 1 : 0;
