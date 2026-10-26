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
import { h, toast } from './ui/dom';
import { activity } from './ui/pages/activity';
import { deposit } from './ui/pages/deposit';
import { home } from './ui/pages/home';
import { receive } from './ui/pages/receive';
import { request } from './ui/pages/request';
import { send } from './ui/pages/send';
import { settings } from './ui/pages/settings';
import { status } from './ui/pages/status';
import { withdraw } from './ui/pages/withdraw';
import { back, start, type Path } from './ui/router';
import { createShell } from './ui/shell';
import type { App, Page } from './ui/widgets';

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
  return `This page is open at ${location.origin}, so tokens would name ${MINT_URL}, but the mint is ${CONFIGURED_MINT}. Open ${CONFIGURED_MINT.replace(/\/mint$/, '')} instead.`;
}

const core = createCore({ mintUrl: MINT_URL, unit: UNIT, mainnet: MAINNET });
const tokens = createTokens(core);
const onchain = initOnchain({
  mintUrl: MINT_URL,
  unit: UNIT,
  mainnet: MAINNET,
  connect: core.connect,
  proofs: core.proofs,
  setProofs: core.setProofs,
  say: core.say,
  explain: core.explain,
  isNetworkError: core.isNetworkError,
});

const app: App = {
  core,
  tokens,
  onchain,
  feed: () => buildFeed({ deposits: onchain.deposits(), withdrawals: onchain.withdrawals(), sent: tokens.sent(), received: tokens.received() }),
  onChange(fn) {
    const a = core.on((e) => e.type !== 'say' && e.type !== 'mint' && fn());
    const b = onchain.subscribe(fn);
    return () => {
      a();
      b();
    };
  },
};

const PAGES: Record<Path, Page> = {
  '/': home,
  '/send': send,
  '/receive': receive,
  '/deposit': deposit,
  '/withdraw': withdraw,
  '/request': request,
  '/activity': activity,
  '/status': status,
  '/settings': settings,
};

if (MAINNET) document.documentElement.classList.add('mainnet');
const shell = createShell({ mainnet: MAINNET, mintHost: new URL(MINT_URL).host, onBack: () => back() });
document.getElementById('app')!.replaceWith(shell.root);
core.on((e) => {
  if (e.type === 'say') toast(e.text, e.tone);
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
  const page = PAGES[route.path];
  shell.setRoute(route.path, page.title);
  if (fatal && route.path !== '/status') {
    shell.view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'fatal', role: 'alert' }, h('span', { class: 'tag t-bad' }, '[ WRONG ADDRESS ]'), h('p', null, fatal))));
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
    if (!units.has(UNIT)) toast(`The mint has no ${UNIT} unit!`, 'bad');
    if (!problem && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      toast(`Opened via ${location.hostname}: tokens will name ${MINT_URL}, which the phone and CLI don't use. Open the LAN address instead.`, 'bad');
    }
    await core.connect();
    onchain.setInfo(info);
    void onchain.resume(); // open deposits and withdrawals, saved across reloads
    await tokens.redeemPending();
  } catch (e) {
    if (!navigator.onLine) return; // the offline strip already says so
    toast(core.explain(e), 'bad');
  }
}

// Offline shell (public/sw.js): lets the page open with no network, for offline receive.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e));
}
// Load the QR decoder's worker now, while online, so scanning also works offline (the service
// worker caches it).
void QrScanner.scanImage(document.createElement('canvas'), { returnDetailedScanResult: true }).catch(() => {});

setInterval(() => {
  if (tokens.pendingOffline().length) void tokens.redeemPending();
  if (core.mintUp() === false && navigator.onLine) void checkMint();
}, 15_000);

void checkMint();
