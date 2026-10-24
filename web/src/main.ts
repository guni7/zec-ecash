// Demo ecash wallet for zec-ecash: the regtest devnet, or MAINNET when built with
// ZEC_NETWORK=mainnet (see vite.config.ts). Proofs live in localStorage only.
//
// The mint is reached through this page's own origin (/mint, proxied to the HTTP mint), so the
// mint URL is <this origin>/mint. Tokens carry that URL, so it must be exactly the configured
// ZEC_MINT_URL (the CLI uses the same one); on MAINNET the page refuses to work otherwise.
import {
  Amount,
  MintOperationError,
  NetworkError,
  Wallet,
  getEncodedToken,
  getTokenMetadata,
  type Proof,
} from '@cashu/cashu-ts';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { loadOrCreateKey, loadPending, savePending, verifyOffline, type PendingReceipt } from './offline';

declare const __ZEC_NETWORK__: 'regtest' | 'mainnet';
declare const __ZEC_MINT_URL__: string;
const MAINNET = __ZEC_NETWORK__ === 'mainnet';
const UNIT = 'zat';
const MINT_URL = `${location.origin}/mint`;
/** ZEC_MINT_URL the page was built for ('' if unset); tokens must name exactly this mint. */
const CONFIGURED_MINT = __ZEC_MINT_URL__.replace(/\/+$/, '');
const STORE_KEY = `zec-ecash-demo:proofs:${MINT_URL}`;
const SENT_KEY = `zec-ecash-demo:last-sent:${MINT_URL}`;
const P2PK_KEY = `zec-ecash-demo:p2pk-key:${MINT_URL}`;
const KEYCHAIN_KEY = `zec-ecash-demo:keychain:${MINT_URL}`;
const PENDING_KEY = `zec-ecash-demo:offline-received:${MINT_URL}`;
/** NUT error code the mint returns for a proof that was already spent. */
const ALREADY_SPENT = 11001;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  mintStatus: $('mint-status'),
  mintLine: $('mint-line'),
  balance: $('balance'),
  receiveInput: $<HTMLTextAreaElement>('receive-input'),
  receiveBtn: $<HTMLButtonElement>('receive-btn'),
  scanBtn: $<HTMLButtonElement>('scan-btn'),
  scanner: $('scanner'),
  scannerVideo: $<HTMLVideoElement>('scanner-video'),
  scanStop: $<HTMLButtonElement>('scan-stop'),
  sendAmount: $<HTMLInputElement>('send-amount'),
  sendBtn: $<HTMLButtonElement>('send-btn'),
  sendCompact: $<HTMLInputElement>('send-compact'),
  sent: $('sent'),
  sentQr: $<HTMLCanvasElement>('sent-qr'),
  sentToken: $<HTMLTextAreaElement>('sent-token'),
  sentNote: $('sent-note'),
  copyBtn: $<HTMLButtonElement>('copy-btn'),
  myQr: $<HTMLCanvasElement>('my-pubkey-qr'),
  myPub: $<HTMLTextAreaElement>('my-pubkey'),
  pending: $('pending'),
  reqAmount: $<HTMLInputElement>('req-amount'),
  reqBtn: $<HTMLButtonElement>('req-btn'),
  req: $('req'),
  reqQr: $<HTMLCanvasElement>('req-qr'),
  reqText: $<HTMLTextAreaElement>('req-text'),
  reqCopy: $<HTMLButtonElement>('req-copy'),
  reqState: $('req-state'),
  message: $('message'),
};

// ---- storage ----

function loadProofs(): Proof[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Array<Proof & { amount: string }>;
    return raw.map((p) => ({ ...p, amount: Amount.from(p.amount) }));
  } catch {
    return [];
  }
}

function saveProofs(proofs: Proof[]) {
  // Amount serializes to a string (Amount.toJSON); loadProofs turns it back into an Amount.
  localStorage.setItem(STORE_KEY, JSON.stringify(proofs));
}

let proofs: Proof[] = loadProofs();
let wallet: Wallet | null = null;
/** This wallet's P2PK key: senders lock tokens to the public half, so they're safe to accept offline. */
const me = loadOrCreateKey(P2PK_KEY);
let pending: PendingReceipt[] = loadPending(PENDING_KEY);

// ---- UI helpers ----

function say(text: string, kind: 'ok' | 'bad' | '' = '') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

function renderBalance() {
  els.balance.textContent = Amount.sum(proofs.map((p) => p.amount)).toString();
  const waiting = pending.reduce((a, p) => a + p.amount, 0);
  els.pending.hidden = pending.length === 0;
  els.pending.textContent = `+ ${waiting} ${UNIT} accepted offline (${pending.length} token${pending.length === 1 ? '' : 's'}), will redeem when online`;
}

function isNetworkError(e: unknown) {
  return !navigator.onLine || e instanceof NetworkError || e instanceof TypeError;
}

function cachedKeychain() {
  try {
    return JSON.parse(localStorage.getItem(KEYCHAIN_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function normalizeMint(url: string) {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** Turns any failure into a sentence a person can act on. */
function explain(e: unknown): string {
  if (e instanceof MintOperationError) {
    if (e.code === ALREADY_SPENT || /already spent/i.test(e.message)) {
      return 'Already spent: this token was redeemed before.';
    }
    return `The mint refused: ${e.message}`;
  }
  if (e instanceof NetworkError || e instanceof TypeError) {
    return MAINNET
      ? `Mint unreachable at ${MINT_URL}. Check your connection and try again; if it persists, the mint may be down for maintenance. Your ecash stays in this browser.`
      : `Mint unreachable at ${MINT_URL}. Is the devnet (scripts/devnet-up.sh) and the web server running?`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function busy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T | undefined> {
  button.disabled = true;
  try {
    return await work();
  } catch (e) {
    say(explain(e), 'bad');
    return undefined;
  } finally {
    button.disabled = false;
  }
}

// ---- mint ----

async function connect(): Promise<Wallet> {
  if (wallet) return wallet;
  // denominationTarget 0: split every mint/swap/receive/send into the minimal powers of two
  // (cashu-ts defaults to keeping 3 proofs of each denomination, which bloats tokens and QRs).
  const w = new Wallet(MINT_URL, { unit: UNIT, denominationTarget: 0 });
  await w.loadMint();
  // Keep the mint's keys for offline DLEQ checks (verifyOffline).
  localStorage.setItem(KEYCHAIN_KEY, JSON.stringify(w.keyChain.cache));
  wallet = w;
  return w;
}

/** Network badge and banner, before anything else can happen. */
function showNetwork() {
  if (!MAINNET) return;
  document.title = `MAINNET · ${document.title}`;
  document.body.classList.add('mainnet');
  $('network-badge').hidden = false;
  $('banner').textContent =
    'MAINNET: real ZEC. Experimental mint; keep only small amounts here. Ecash lives only in this browser: clearing site data loses it.';
}

/** The page must be opened at the configured mint URL, or tokens would name another mint. */
function mintUrlProblem(): string | undefined {
  if (!CONFIGURED_MINT || CONFIGURED_MINT === MINT_URL) return undefined;
  return `This page is open at ${location.origin}, so tokens would name ${MINT_URL}, but the mint is ${CONFIGURED_MINT}. Open ${CONFIGURED_MINT.replace(/\/mint$/, '')} instead.`;
}

async function checkMint() {
  const problem = mintUrlProblem();
  if (problem && MAINNET) {
    // On MAINNET this is fatal: tokens made here would carry the wrong mint URL.
    els.mintStatus.className = 'dot bad';
    els.mintLine.textContent = `wrong address · ${MINT_URL}`;
    document.querySelectorAll('button, input, textarea').forEach((el) => ((el as HTMLButtonElement).disabled = true));
    say(problem, 'bad');
    return;
  }
  if (problem) say(problem, 'bad');
  try {
    const res = await fetch(`${MINT_URL}/v1/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as { name?: string; nuts?: Record<string, { methods?: Array<{ unit: string }> }> };
    const units = new Set((info.nuts?.['4']?.methods ?? []).map((m) => m.unit));
    els.mintStatus.className = 'dot ok';
    els.mintLine.textContent = `${info.name ?? 'mint'} · ${MINT_URL}` + (units.has(UNIT) ? '' : ` · no ${UNIT} unit!`);
    if (!problem && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      say(`Opened via ${location.hostname}: tokens will name ${MINT_URL}, which the phone and CLI don't use. Open the LAN address instead.`, 'bad');
    }
    await connect();
    await redeemPending();
  } catch (e) {
    els.mintStatus.className = 'dot bad';
    els.mintLine.textContent = `mint unreachable · ${MINT_URL}`;
    say(explain(e instanceof Error && !(e instanceof MintOperationError) ? new TypeError(e.message) : e), 'bad');
  }
}

// ---- receive ----

async function receive(token: string) {
  token = token.trim();
  if (!token) throw new Error('Paste or scan a token first.');
  let meta;
  try {
    meta = getTokenMetadata(token);
  } catch {
    throw new Error('That is not a Cashu token.');
  }
  if (meta.unit !== UNIT) throw new Error(`Wrong unit: this token is in ${meta.unit}; this wallet only takes ${UNIT}.`);
  if (normalizeMint(meta.mint) !== normalizeMint(MINT_URL)) {
    throw new Error(`Wrong mint: this token is from ${meta.mint}; this wallet uses ${MINT_URL}.`);
  }
  let received: Proof[];
  try {
    const w = await connect();
    // privkey: signs for proofs P2PK-locked to this wallet (ignored for unlocked ones).
    received = await w.receive(token, { privkey: me.priv });
  } catch (e) {
    if (isNetworkError(e)) return acceptOffline(token);
    throw e;
  }
  proofs = [...proofs, ...received];
  saveProofs(proofs);
  renderBalance();
  els.receiveInput.value = '';
  say(`Received ${Amount.sum(received.map((p) => p.amount)).toString()} ${UNIT} (redeemed at mint).`, 'ok');
}

/** No mint: accept only what verifyOffline proves safe, and queue it for redemption. */
function acceptOffline(token: string) {
  const verdict = verifyOffline(token, cachedKeychain(), MINT_URL, UNIT, me.pub);
  if (!verdict.ok) throw new Error(`Offline, not accepted: ${verdict.reason}`);
  if (pending.some((p) => p.token === token)) throw new Error('This token is already waiting to be redeemed.');
  pending = [...pending, { token, amount: verdict.amount, at: Date.now() }];
  savePending(PENDING_KEY, pending);
  renderBalance();
  els.receiveInput.value = '';
  say(`Accepted offline: ${verdict.amount} ${UNIT}, locked to this wallet with valid mint signatures. Will redeem when online.`, 'ok');
}

let redeeming = false;

/** Redeems queued offline receipts; keeps them queued while the mint is unreachable. */
async function redeemPending() {
  if (redeeming || pending.length === 0) return;
  redeeming = true;
  try {
    const w = await connect();
    for (const p of [...pending]) {
      try {
        const got = await w.receive(p.token, { privkey: me.priv });
        proofs = [...proofs, ...got];
        saveProofs(proofs);
        say(`Redeemed ${p.amount} ${UNIT} accepted offline.`, 'ok');
      } catch (e) {
        if (isNetworkError(e)) return; // still offline: try again later
        say(`An offline-accepted token could not be redeemed: ${explain(e)}`, 'bad');
      }
      pending = pending.filter((q) => q.token !== p.token);
      savePending(PENDING_KEY, pending);
      renderBalance();
    }
  } catch {
    /* mint unreachable: keep the queue */
  } finally {
    redeeming = false;
  }
}

// ---- send ----

async function send(amountText: string) {
  const amount = Number(amountText);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
  const balance = Amount.sum(proofs.map((p) => p.amount));
  if (balance.lessThan(amount)) throw new Error(`Not enough ecash: balance is ${balance.toString()} ${UNIT}.`);
  const w = await connect();
  const { keep, send: out } = await w.send(amount, proofs);
  proofs = keep;
  saveProofs(proofs);
  renderBalance();
  // Compact drops the DLEQ proofs (NUT-12): about half the size, but no offline check for the receiver.
  const token = getEncodedToken({ mint: MINT_URL, unit: UNIT, proofs: out }, { removeDleq: els.sendCompact.checked });
  localStorage.setItem(SENT_KEY, token);
  await showSent(token, `${amount} ${UNIT} · ${out.length} proofs · ${token.length} chars`);
  say(`Created a ${amount} ${UNIT} token. It's spendable by whoever has it: hand it over now.`, 'ok');
}

async function showSent(token: string, note: string) {
  els.sent.hidden = false;
  els.sentToken.value = token;
  els.sentNote.textContent = note;
  try {
    await QRCode.toCanvas(els.sentQr, token, { errorCorrectionLevel: 'L', margin: 1, width: 320 });
    els.sentQr.hidden = false;
  } catch {
    els.sentQr.hidden = true;
    els.sentNote.textContent = `${note} · too long for one QR code, copy the text`;
  }
}

// ---- point of sale (NUT-18) ----

const POS_URL = `${location.origin}/pos`;
let reqPoll: ReturnType<typeof setInterval> | null = null;

async function createRequest(amountText: string) {
  const amount = Number(amountText);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
  let res: Response;
  try {
    res = await fetch(`${POS_URL}/create?amount=${amount}&unit=${UNIT}`);
  } catch {
    throw new Error(
      MAINNET
        ? `Point of sale unreachable at ${POS_URL}. Try again later.`
        : `Point of sale unreachable at ${POS_URL} (is crates/pos running? scripts/devnet-up.sh status).`,
    );
  }
  const body = (await res.json()) as { id?: string; request?: string; error?: string };
  if (!res.ok || !body.id || !body.request) throw new Error(`Point of sale: ${body.error ?? res.status}`);
  els.req.hidden = false;
  els.reqText.value = body.request;
  els.reqState.textContent = `${amount} ${UNIT} · waiting for payment…`;
  els.reqState.className = 'muted';
  await QRCode.toCanvas(els.reqQr, body.request, { errorCorrectionLevel: 'L', margin: 1, width: 300 });
  if (reqPoll) clearInterval(reqPoll);
  const id = body.id;
  reqPoll = setInterval(async () => {
    try {
      const r = await fetch(`${POS_URL}/check/${id}`);
      const q = (await r.json()) as { state?: string; received?: number };
      if (q.state === 'PAID') {
        els.reqState.textContent = `PAID · ${q.received} ${UNIT} received`;
        els.reqState.className = 'message ok';
        if (reqPoll) clearInterval(reqPoll);
      } else if (q.state) {
        els.reqState.textContent = `${amount} ${UNIT} · ${q.state.toLowerCase()}…`;
      }
    } catch {
      /* transient; keep polling */
    }
  }, 2000);
  say('Request created: have the payer scan it (e.g. zec-ecash-cli pay <request>).', 'ok');
}

// ---- camera ----

let scanner: QrScanner | null = null;

async function startScan() {
  els.scanner.hidden = false;
  scanner ??= new QrScanner(
    els.scannerVideo,
    (result) => {
      stopScan();
      els.receiveInput.value = result.data;
      void busy(els.receiveBtn, () => receive(result.data));
    },
    { preferredCamera: 'environment', highlightScanRegion: true, returnDetailedScanResult: true },
  );
  try {
    await scanner.start();
    say('Point the camera at a token QR code.');
  } catch (e) {
    stopScan();
    say(`Camera unavailable: ${e instanceof Error ? e.message : e}. (Needs HTTPS and camera permission.)`, 'bad');
  }
}

function stopScan() {
  scanner?.stop();
  els.scanner.hidden = true;
}

// ---- wiring ----

els.receiveBtn.onclick = () => void busy(els.receiveBtn, () => receive(els.receiveInput.value));
els.scanBtn.onclick = () => void startScan();
els.scanStop.onclick = () => stopScan();
els.sendBtn.onclick = () => void busy(els.sendBtn, () => send(els.sendAmount.value));
els.reqBtn.onclick = () => void busy(els.reqBtn, () => createRequest(els.reqAmount.value));
els.reqCopy.onclick = async () => {
  try {
    await navigator.clipboard.writeText(els.reqText.value);
    say('Request copied.', 'ok');
  } catch {
    els.reqText.select();
  }
};
els.copyBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(els.sentToken.value);
    say('Token copied.', 'ok');
  } catch {
    els.sentToken.select();
    say('Copy blocked by the browser: the token text is selected, copy it by hand.', 'bad');
  }
};

// Offline shell (public/sw.js): lets the page open with no network, for offline receive.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker:', e));
}
// Load the QR decoder's worker now, while online, so scanning also works offline (the service
// worker caches it).
void QrScanner.scanImage(document.createElement('canvas'), { returnDetailedScanResult: true }).catch(() => {});

window.addEventListener('online', () => void checkMint());
setInterval(() => {
  if (pending.length > 0) void redeemPending();
}, 15_000);

renderBalance();
els.myPub.value = me.pub;
void QRCode.toCanvas(els.myQr, me.pub, { errorCorrectionLevel: 'L', margin: 1, width: 220 });
const lastSent = localStorage.getItem(SENT_KEY);
if (lastSent) void showSent(lastSent, 'last token you created');
showNetwork();
void checkMint();
