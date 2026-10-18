// Demo ecash wallet for the zec-ecash regtest devnet. Proofs live in localStorage only.
//
// The mint is reached through this page's own origin (/mint, proxied by the Vite dev server to
// the HTTP mint), so the mint URL is https://<host>:5173/mint. Tokens carry that URL, so the CLI
// must use exactly the same one (ZEC_MINT_URL).
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

const UNIT = 'zat';
const MINT_URL = `${location.origin}/mint`;
const STORE_KEY = `zec-ecash-demo:proofs:${MINT_URL}`;
const SENT_KEY = `zec-ecash-demo:last-sent:${MINT_URL}`;
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
  sent: $('sent'),
  sentQr: $<HTMLCanvasElement>('sent-qr'),
  sentToken: $<HTMLTextAreaElement>('sent-token'),
  sentNote: $('sent-note'),
  copyBtn: $<HTMLButtonElement>('copy-btn'),
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

// ---- UI helpers ----

function say(text: string, kind: 'ok' | 'bad' | '' = '') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
}

function renderBalance() {
  els.balance.textContent = Amount.sum(proofs.map((p) => p.amount)).toString();
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
    return `Mint unreachable at ${MINT_URL}. Is the devnet (scripts/devnet-up.sh) and the web server running?`;
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
  const w = new Wallet(MINT_URL, { unit: UNIT });
  await w.loadMint();
  wallet = w;
  return w;
}

async function checkMint() {
  try {
    const res = await fetch(`${MINT_URL}/v1/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as { name?: string; nuts?: Record<string, { methods?: Array<{ unit: string }> }> };
    const units = new Set((info.nuts?.['4']?.methods ?? []).map((m) => m.unit));
    els.mintStatus.className = 'dot ok';
    els.mintLine.textContent = `${info.name ?? 'mint'} · ${MINT_URL}` + (units.has(UNIT) ? '' : ` · no ${UNIT} unit!`);
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      say(`Opened via ${location.hostname}: tokens will name ${MINT_URL}, which the phone and CLI don't use. Open the LAN address instead.`, 'bad');
    }
    await connect();
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
  const w = await connect();
  const received = await w.receive(token);
  proofs = [...proofs, ...received];
  saveProofs(proofs);
  renderBalance();
  els.receiveInput.value = '';
  say(`Received ${Amount.sum(received.map((p) => p.amount)).toString()} ${UNIT} (redeemed at mint).`, 'ok');
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
  const token = getEncodedToken({ mint: MINT_URL, unit: UNIT, proofs: out });
  localStorage.setItem(SENT_KEY, token);
  await showSent(token, `${amount} ${UNIT}`);
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
els.copyBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(els.sentToken.value);
    say('Token copied.', 'ok');
  } catch {
    els.sentToken.select();
    say('Copy blocked by the browser: the token text is selected, copy it by hand.', 'bad');
  }
};

renderBalance();
const lastSent = localStorage.getItem(SENT_KEY);
if (lastSent) void showSent(lastSent, 'last token you created');
void checkMint();
