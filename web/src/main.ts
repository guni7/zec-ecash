// zec-ecash web wallet: the regtest devnet, or MAINNET when built with ZEC_NETWORK=mainnet (see
// vite.config.ts). Ecash lives in localStorage only.
//
// The mint is reached through this page's own origin (/mint, proxied to the HTTP mint), so the
// mint URL is <this origin>/mint. Tokens carry that URL, so it must be exactly the configured
// ZEC_MINT_URL (the CLI uses the same one); on MAINNET the page refuses to work otherwise.
//
// Layout: src/wallet/* is the wallet (no DOM); src/ui/* the pages, shell and router.
import '@fontsource/unbounded/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './style.css';
import QrScanner from 'qr-scanner';
import { buildFeed } from './wallet/activity';
import { createCore } from './wallet/core';
import { initOnchain } from './wallet/onchain';
import { createTokens } from './wallet/tokens';
import { createPosRequests } from './wallet/posreq';
import { holdings } from './wallet/backup';
import { h, toast } from './ui/dom';
import { activity } from './ui/pages/activity';
import { deposit } from './ui/pages/deposit';
import { home } from './ui/pages/home';
import { receive } from './ui/pages/receive';
import { scan } from './ui/pages/scan';
import { send } from './ui/pages/send';
import { settings } from './ui/pages/settings';
import { status } from './ui/pages/status';
import { welcome } from './ui/pages/welcome';
import { withdraw } from './ui/pages/withdraw';
import { createPrefs } from './ui/prefs';
import { go, navKind, start, type Path } from './ui/router';
import { createShell } from './ui/shell';
import { waiting, type App, type Page } from './ui/widgets';
import { plain, plainOrNull } from './ui/words';

declare const __ZEC_NETWORK__: 'regtest' | 'mainnet';
declare const __ZEC_MINT_URL__: string;
const MAINNET = __ZEC_NETWORK__ === 'mainnet';
const UNIT = 'zat';
const MINT_URL = `${location.origin}/mint`;
/** ZEC_MINT_URL the page was built for ('' if unset); tokens must name exactly this mint. */
const CONFIGURED_MINT = __ZEC_MINT_URL__.replace(/\/+$/, '');

/** The page must be opened at the configured mint URL, or tokens would name another mint. */
function mintUrlProblem(): string | undefined {
  if (!CONFIGURED_MINT || CONFIGURED_MINT === MINT_URL) return undefined;
  return `This page is open at the wrong address (${location.origin}): money made here wouldn't work. Open ${CONFIGURED_MINT.replace(/\/mint$/, '')} instead.`;
}

const core = createCore({ mintUrl: MINT_URL, unit: UNIT, mainnet: MAINNET });
const posreq = createPosRequests(core);
const tokens = createTokens(core, () => posreq.allKeys());
const onchain = initOnchain({
  mintUrl: MINT_URL,
  unit: UNIT,
  mainnet: MAINNET,
  connect: core.connect,
  proofs: core.proofs,
  changeProofs: core.changeProofs,
  dropSpent: core.dropSpent,
  say: core.say,
  explain: core.explain,
  isNetworkError: core.isNetworkError,
});

const prefs = createPrefs(core.key('ui'));

const app: App = {
  core,
  tokens,
  onchain,
  posreq,
  prefs,
  explain: (e) => plain(core.explain(e)),
  setShopMode: (on) => setShopMode(on),
  feed: () => buildFeed({ deposits: onchain.deposits(), withdrawals: onchain.withdrawals(), sent: tokens.sent(), received: tokens.received(), requests: posreq.records() }),
  onChange(fn) {
    const a = core.on((e) => e.type !== 'say' && e.type !== 'mint' && fn());
    const b = onchain.subscribe(fn);
    return () => {
      a();
      b();
    };
  },
};

type ShopKey = 'charge' | 'invoices' | 'dashboard' | 'shop' | 'invoice' | 'receipt';

/**
 * A shop page: its code, and the shop's data on this device, load on first use, so the wallet
 * alone never downloads them. Customer pages (an invoice or receipt link) don't open the shop.
 */
function shopPage(key: ShopKey, title: string): Page {
  return {
    title,
    render(app, route) {
      const el = h('div', { class: 'lazy' }, h('div', { class: 'page' }, h('div', { class: 'working' }, waiting('Loading…'))));
      let done: (() => void) | undefined;
      let gone = false;
      import('./shop/ui').then(
        async (m) => {
          const shop = key === 'invoice' || key === 'receipt' ? (null as never) : await m.shopFor(app);
          if (gone) return;
          const r = m.pages[key](shop).render(app, route);
          done = r.cleanup;
          el.replaceChildren(r.el);
          shell.afterRender();
          (r.el.querySelector('.page-title') as HTMLElement | null)?.focus({ preventScroll: true });
        },
        (e) => el.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'field-err' }, `This page couldn’t load (${app.explain(e)}). Check your connection and reload.`))),
      );
      return {
        el,
        cleanup: () => {
          gone = true;
          done?.();
        },
      };
    },
  };
}

const PAGES: Record<Path, Page> = {
  '/': home,
  '/send': send,
  '/scan': scan,
  '/receive': receive,
  '/activity': activity,
  '/deposit': deposit,
  '/withdraw': withdraw,
  '/status': status,
  '/settings': settings,
  '/welcome': welcome,
  '/charge': shopPage('charge', 'Charge'),
  '/invoices': shopPage('invoices', 'Invoices'),
  '/dashboard': shopPage('dashboard', 'Dashboard'),
  '/shop': shopPage('shop', 'Shop'),
  '/invoice': shopPage('invoice', 'Invoice'),
  '/receipt': shopPage('receipt', 'Receipt'),
};

/** A wallet that has never held anything: Home starts with the first-run screen. */
const fresh = () => holdings(MINT_URL).empty && !app.feed().length;

if (MAINNET) document.documentElement.classList.add('mainnet');
const shell = createShell({ mainnet: MAINNET, mintHost: new URL(MINT_URL).host, onPersonal: () => setShopMode(false) });

/** Shop mode on or off: the navigation, and the shop's name on the strip. */
function setShopMode(on: boolean) {
  prefs.set({ shopMode: on });
  shell.setMode(on);
  if (on) void import('./shop/open').then(async (m) => shell.setMode(!!prefs.get().shopMode, (await m.shopFor(app)).profile()?.name ?? ''));
  go(on ? '/charge' : '/', true);
}
if (prefs.get().shopMode) {
  shell.setMode(true);
  void import('./shop/open').then(async (m) => shell.setMode(!!prefs.get().shopMode, (await m.shopFor(app)).profile()?.name ?? ''));
}
document.getElementById('app')!.replaceWith(shell.root);
core.on((e) => {
  if (e.type === 'say') {
    const text = plainOrNull(e.text);
    if (text) toast(text, e.tone);
  }
  if (e.type === 'mint') shell.setConnectivity(navigator.onLine, e.up);
});
const net = () => shell.setConnectivity(navigator.onLine, core.mintUp());
window.addEventListener('online', () => {
  net();
  void checkMint();
});
window.addEventListener('offline', net);
net();

let cleanup: (() => void) | undefined;
let fatal: string | undefined;

start((route) => {
  cleanup?.();
  cleanup = undefined;
  if (route.path === '/' && !prefs.get().welcomed) {
    if (fresh()) return go('/welcome', true);
    prefs.set({ welcomed: true }); // a wallet from before the first-run screen
  }
  // A shop opens at its counter.
  if (route.path === '/' && prefs.get().shopMode && navKind() === 'load') return go('/charge', true);
  const page = PAGES[route.path];
  shell.setRoute(route.path);
  document.title = route.path === '/' ? 'zec-ecash wallet' : `${page.title} · zec-ecash`;
  if (fatal && route.path !== '/status') {
    shell.view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'fatal', role: 'alert' }, h('h1', { class: 'page-title' }, 'Wrong address'), h('p', null, fatal))));
    return;
  }
  const { el, cleanup: c } = page.render(app, route);
  cleanup = c;
  shell.view.replaceChildren(el);
  shell.afterRender();
  window.scrollTo(0, 0);
  (el.querySelector('.page-title') as HTMLElement | null)?.focus({ preventScroll: true });
});

async function checkMint() {
  const problem = mintUrlProblem();
  if (problem && MAINNET) {
    // On MAINNET this is fatal: tokens made here would carry the wrong mint URL.
    fatal = problem;
    core.setMintUp(false);
    toast(problem, 'bad');
    location.hash = '#/status';
    return;
  }
  if (problem) toast(problem, 'bad');
  try {
    const info = await core.loadInfo();
    const units = new Set((info.nuts?.['4']?.methods ?? []).map((m) => m.unit));
    if (!units.has(UNIT)) toast(`The service doesn't take ${UNIT} (the mint has no ${UNIT} unit).`, 'bad');
    if (!problem && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      toast(`Opened via ${location.hostname}: codes made here won't work on other devices. Open the LAN address instead.`, 'bad');
    }
    await core.connect();
    // proofs spent elsewhere (this wallet in another tab, or an older backup restored) come out
    const dropped = await core.dropSpent().catch(() => 0);
    if (dropped) console.info(`dropped ${dropped} ${UNIT} of already-spent ecash`);
    onchain.setInfo(info);
    void onchain.resume(); // open deposits and withdrawals, saved across reloads
    void collectPos(); // payments to this phone's point-of-sale requests
    await tokens.redeemPending();
  } catch (e) {
    if (!navigator.onLine) return; // the offline strip already says so
    toast(app.explain(e), 'bad');
  }
}

// Offline shell (public/sw.js): lets the page open with no network, for offline receive.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e));
}
// Load the QR decoder's worker now, while online, so scanning also works offline (the service
// worker caches it).
void QrScanner.scanImage(document.createElement('canvas'), { returnDetailedScanResult: true }).catch(() => {});

/** Collects payments to this phone's requests; a wallet with none (new or restored) looks first. */
async function collectPos() {
  if (!posreq.records().length) await posreq.scan().catch(() => 0);
  await posreq.collectAll();
}

setInterval(() => {
  if (posreq.needsWork()) void posreq.collectAll();
}, 20_000);

setInterval(() => {
  if (tokens.pendingOffline().length) void tokens.redeemPending();
  if (core.mintUp() === false && navigator.onLine) void checkMint();
}, 15_000);

void checkMint();
