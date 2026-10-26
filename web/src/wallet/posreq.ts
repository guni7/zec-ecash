// Point-of-sale requests whose payments only this phone can spend (crates/pos, src/locked.rs).
//
// Each request gets a fresh P2PK key, derived from this wallet's seed by index
// (HMAC-SHA256(seed, "zec-ecash-web/pos-request/v1/<index>")), so a wallet restored from its
// seed finds them again; an index is used once, so the mint can't link a shop's payments when
// they are redeemed. Payers lock to that key; the POS server checks and stores the payment; this
// module collects it: a signed fetch of the stored token, a swap at the mint signed with the
// request's key (NUT-11), the proofs saved, then a signed ack so the server deletes its copy.
//
// Crash safety, as for deposits (onchain.ts): the swap preview is saved before the swap; a lost
// answer is recovered with NUT-09 restore; proofs are de-duplicated by secret. No DOM.
import {
  CheckStateEnum,
  OutputData,
  decodePaymentRequest,
  deserializeSwapPreview,
  getEncodedToken,
  serializeSwapPreview,
  type OutputDataLike,
  type Proof,
  type SerializedSwapPreview,
  type Wallet,
} from '@cashu/cashu-ts';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { loadJson, saveJson, sumAmounts, type Core } from './core';
import { PosOfflineError as PosOffline } from './pos';

/** How many unused key indexes a restored wallet looks at past the last one it knows. */
export const SCAN_GAP = 10;

export type PosRecord = {
  id: string;
  index: number;
  pubkey: string;
  amount: number;
  created: number;
  /** The creqA string (to show its QR again). Absent for requests found by a restore scan. */
  request?: string;
  /** open: not paid; paid: a payment waits on the server; collecting: swap prepared (preview
   * saved); collected: proofs saved, ack pending; done: the server deleted its copy. */
  state: 'open' | 'paid' | 'collecting' | 'collected' | 'done';
  received?: number;
  /** Amount redeemed into this wallet. */
  collected?: number;
  preview?: SerializedSwapPreview;
  paidAt?: number;
  error?: string;
  /** Payments that lost the race or came after PAID, kept by the server for this phone. */
  extras?: ExtraPayment[];
  /** Last time a collected request was asked for late extra payments. */
  extrasCheckedAt?: number;
};

/** An extra payment (the request was already paid) or a partial one (short of the request):
 * collected like the main one; the payee may refund it by hand. */
export type ExtraPayment = {
  n: number;
  kind?: 'extra' | 'partial';
  received: number;
  at: number;
  state: 'paid' | 'collecting' | 'collected' | 'done';
  preview?: SerializedSwapPreview;
  collected?: number;
  error?: string;
  /** The sent token (tokens.ts) that refunded it. */
  refundId?: string;
};

/** A collected request is still asked for late extra payments for this long, at most once a minute. */
const LATE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const lateCheckDue = (r: PosRecord, gapMs = 60_000) => r.state === 'done' && Date.now() - r.created < LATE_WINDOW_MS && Date.now() - (r.extrasCheckedAt ?? 0) > gapMs;
/** Something to collect, acknowledge or check for this request (late extras: every `gapMs`). */
export const needsWork = (r: PosRecord, gapMs?: number) => r.state !== 'done' || (r.extras ?? []).some((e) => e.state !== 'done') || lateCheckDue(r, gapMs);

type Slot = { state: string; preview?: SerializedSwapPreview; collected?: number; error?: string };

type Signed = { 'x-pos-time': string; 'x-pos-sig': string };

/** BIP-340 over SHA-256 of the message: what cdk's PublicKey::verify checks on the server. */
export function signHeaders(priv: string, action: string, subject: string, now = Date.now(), skewMs = 0): Signed {
  const t = Math.floor((now + skewMs) / 1000);
  const msg = utf8ToBytes(`zec-ecash-pos-v1\n${action}\n${subject}\n${t}`);
  return { 'x-pos-time': String(t), 'x-pos-sig': bytesToHex(schnorr.sign(sha256(msg), hexToBytes(priv))) };
}

/** Request key `index` from the seed (hex): {priv, pub (compressed hex)}. */
export function deriveKey(seedHex: string, index: number): { priv: string; pub: string } {
  for (let attempt = 0; ; attempt++) {
    const sk = hmac(sha256, hexToBytes(seedHex), utf8ToBytes(`zec-ecash-web/pos-request/v1/${index}${attempt ? `/${attempt}` : ''}`));
    if (secp256k1.utils.isValidSecretKey(sk)) return { priv: bytesToHex(sk), pub: bytesToHex(secp256k1.getPublicKey(sk, true)) };
  }
}

const POS = () => `${location.origin}/pos`;

export function createPosRequests(core: Core) {
  const SEED = core.key('seed');
  const NEXT = core.key('pos-next');
  const RECS = core.key('pos-requests');
  /** The wallet seed (32 bytes, hex): created once, in every backup. */
  let seed = localStorage.getItem(SEED);
  if (!seed || !/^[0-9a-f]{64}$/.test(seed)) {
    seed = bytesToHex(randomBytes(32));
    localStorage.setItem(SEED, seed);
  }
  const SEEDHEX = seed;
  let records = loadJson<PosRecord[]>(RECS, []);
  const save = () => {
    saveJson(RECS, records);
    core.emit({ type: 'activity' });
  };
  const keyOf = (r: Pick<PosRecord, 'index'>) => deriveKey(SEEDHEX, r.index);
  /** Server clock minus ours, from the Date header, so signatures stay inside its 60 s window. */
  let skew = 0;
  const noteSkew = (res: Response) => {
    const d = Date.parse(res.headers.get('date') ?? '');
    if (!Number.isNaN(d) && Math.abs(d - Date.now()) > 30_000) skew = d - Date.now();
  };

  async function signedFetch(path: string, priv: string, action: string, subject: string, init: RequestInit = {}) {
    let res = await fetch(`${POS()}${path}`, { ...init, cache: 'no-store', headers: { ...signHeaders(priv, action, subject, Date.now(), skew) } });
    noteSkew(res);
    if (res.status === 401 && /expired/.test(await res.clone().text())) {
      res = await fetch(`${POS()}${path}`, { ...init, cache: 'no-store', headers: { ...signHeaders(priv, action, subject, Date.now(), skew) } });
    }
    return res;
  }

  /** The next unused index; advanced and saved before the key is used, so it is never reused. */
  function takeIndex(): number {
    const used = Math.max(-1, ...records.map((r) => r.index));
    const i = Math.max(Number(localStorage.getItem(NEXT) ?? 0), used + 1);
    localStorage.setItem(NEXT, String(i + 1));
    return i;
  }

  /** Creates a request locked to a fresh key. */
  async function create(amount: number): Promise<PosRecord> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
    for (let tries = 0; tries < 20; tries++) {
      const index = takeIndex();
      const { pub } = deriveKey(SEEDHEX, index);
      let res: Response;
      try {
        res = await fetch(`${POS()}/create?amount=${amount}&unit=${core.unit}&pubkey=${pub}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      } catch {
        throw new PosOffline();
      }
      if (res.status >= 500) throw new PosOffline();
      const body = (await res.json().catch(() => ({}))) as { id?: string; request?: string; error?: string };
      if (res.status === 409) continue; // key already used (a restored wallet): the next one
      if (!res.ok || !body.id || !body.request) throw new Error(`Point of sale: ${body.error ?? `HTTP ${res.status}`}`);
      const rec: PosRecord = { id: body.id, index, pubkey: pub, amount, created: Date.now(), request: body.request, state: 'open' };
      records = [rec, ...records];
      save();
      return rec;
    }
    throw new Error('Could not find an unused key for the request.');
  }

  /** NUT-09: signatures the mint already made for these outputs (a swap answer we never got). */
  async function restore(w: Wallet, outputs: OutputDataLike[]): Promise<Proof[]> {
    if (!outputs.length) return [];
    const res = await w.mint.restore({ outputs: outputs.map((o) => o.blindedMessage) });
    if (!res.signatures.length) return [];
    const byB = new Map(outputs.map((o) => [o.blindedMessage.B_, o]));
    const matched = res.outputs.map((o) => byB.get(o.B_)).filter((o): o is OutputData => !!o);
    await w.ensureOperableKeysets(res.signatures.map((s) => s.id));
    return w.createMeltChangeProofs(matched, res.signatures);
  }

  const addProofs = (extra: Proof[]) => {
    const have = new Set(core.proofs().map((p) => p.secret));
    core.setProofs([...core.proofs(), ...extra.filter((p) => !have.has(p.secret))]);
  };

  /** Saves the prepared swap of a stored token (signed later with the request's key). */
  async function prepare(w: Wallet, slot: Slot, token: string) {
    const preview = await w.prepareSwapToReceive(token, { requireDleq: true });
    slot.preview = serializeSwapPreview(preview);
    slot.state = 'collecting';
    save();
  }

  /** Swap the paid token into this wallet's own proofs (signing with the request's key). */
  async function redeem(w: Wallet, priv: string, slot: Slot, what: string) {
    const preview = deserializeSwapPreview(slot.preview!);
    let got: Proof[];
    try {
      const out = await w.completeSwap(preview, priv);
      got = [...out.keep, ...out.send];
    } catch (e) {
      if (core.isNetworkError(e)) throw e;
      // The mint may have done the swap and the answer was lost; or the inputs were spent elsewhere.
      got = await restore(w, [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])]);
      if (!got.length) {
        const states = await w.checkProofsStates(preview.inputs);
        if (states.every((s) => s.state === CheckStateEnum.UNSPENT)) {
          delete slot.preview;
          slot.state = 'paid'; // nothing happened: start again with fresh outputs
          save();
        }
        throw e;
      }
    }
    addProofs(got); // proofs first, then the record moves on
    slot.collected = sumAmounts(got);
    slot.state = 'collected';
    delete slot.preview;
    delete slot.error;
    save();
    core.say(`Collected ${slot.collected.toLocaleString('en-US')} ${core.unit} ${what}.`, 'ok');
  }

  /** Asks the server to delete its copy (main payment, or extra payment n). */
  async function acknowledge(priv: string, id: string, n?: number): Promise<boolean> {
    const subject = n === undefined ? id : `${id}/extra/${n}`;
    const res = await signedFetch(`/requests/${encodeURIComponent(id)}/ack${n === undefined ? '' : `?extra=${n}`}`, priv, 'ack', subject, { method: 'POST' });
    if (res.status >= 500) throw new PosOffline();
    return res.ok;
  }

  type Served = {
    state?: string;
    token?: string | null;
    collected?: boolean;
    received?: number;
    error?: string;
    extras?: Array<{ n: number; kind?: 'extra' | 'partial'; received: number; token?: string | null; collected: boolean }>;
  };

  async function step(w: Wallet, rec: PosRecord, gapMs?: number) {
    const { priv } = keyOf(rec);
    const exs = (rec.extras ??= []);
    let body: Served | undefined;
    if (rec.state === 'open' || rec.state === 'paid' || exs.some((e) => e.state === 'paid') || lateCheckDue(rec, gapMs)) {
      const res = await signedFetch(`/requests/${encodeURIComponent(rec.id)}/payment`, priv, 'collect', rec.id);
      if (res.status >= 500) throw new PosOffline();
      body = (await res.json().catch(() => ({}))) as Served;
      if (!res.ok) throw new Error(`Point of sale: ${body.error ?? `HTTP ${res.status}`}`);
      rec.extrasCheckedAt = Date.now();
      for (const e of body.extras ?? []) {
        if (exs.some((x) => x.n === e.n)) continue;
        exs.push({ n: e.n, kind: e.kind ?? 'extra', received: e.received, at: Date.now(), state: e.collected ? 'done' : 'paid' });
        if (!e.collected)
          core.say(
            e.kind === 'partial'
              ? `Partial payment received: ${e.received.toLocaleString('en-US')} of ${rec.amount.toLocaleString('en-US')} ${core.unit}. The request is still unpaid; you can refund it.`
              : `Extra payment received: ${e.received.toLocaleString('en-US')} ${core.unit} (the request was already paid). You can refund it.`,
            'ok',
          );
      }
      save();
    }

    // The main payment.
    if (body && (rec.state === 'open' || rec.state === 'paid')) {
      if (body.collected) {
        rec.state = 'done'; // already collected (another device with this seed)
        save();
      } else if (body.state === 'PAID' && body.token) {
        if (rec.state === 'open') {
          rec.state = 'paid';
          rec.received = body.received;
          rec.paidAt = Date.now();
          save();
        }
        await prepare(w, rec, body.token); // saved before the swap is sent
      }
    }
    if (rec.state === 'collecting') await redeem(w, priv, rec, 'paid to your request');
    if (rec.state === 'collected' && (await acknowledge(priv, rec.id))) {
      rec.state = 'done';
      save();
    }

    // Extra payments, the same way.
    for (const ex of exs) {
      if (ex.state === 'paid') {
        const served = body?.extras?.find((e) => e.n === ex.n);
        if (served?.collected) {
          ex.state = 'done';
          save();
        } else if (served?.token) await prepare(w, ex, served.token);
      }
      if (ex.state === 'collecting') await redeem(w, priv, ex, ex.kind === 'partial' ? 'from a partial payment' : 'from an extra payment');
      if (ex.state === 'collected' && (await acknowledge(priv, rec.id, ex.n))) {
        ex.state = 'done';
        save();
      }
    }
  }

  let running = false;
  /** Collects every paid request (and acks every collected one). Safe to call any time.
   * `lateGapMs`: how often collected requests are asked for late extra payments (a page showing
   * one asks often; the background poller once a minute). */
  async function collectAll(only?: (r: PosRecord) => boolean, lateGapMs?: number) {
    if (running) return;
    running = true;
    try {
      const todo = records.filter((r) => needsWork(r, lateGapMs) && (!only || only(r)));
      if (!todo.length) return;
      const w = await core.connect();
      for (const rec of todo) {
        try {
          await step(w, rec, lateGapMs);
        } catch (e) {
          if (e instanceof PosOffline || core.isNetworkError(e)) return; // retried on the next pass
          rec.error = core.explain(e);
          save();
        }
      }
    } catch {
      /* mint unreachable: next pass */
    } finally {
      running = false;
    }
  }

  /** A wallet restored from its seed: find requests made with its keys (scan past the last known). */
  async function scan() {
    const known = new Set(records.map((r) => r.index));
    const last = Math.max(-1, ...records.map((r) => r.index), Number(localStorage.getItem(NEXT) ?? 0) - 1);
    let found = 0;
    for (let i = 0, miss = 0; miss < SCAN_GAP; i++) {
      if (known.has(i)) {
        miss = 0;
        continue;
      }
      const { priv, pub } = deriveKey(SEEDHEX, i);
      let res: Response;
      try {
        res = await signedFetch(`/keys/${pub}/requests`, priv, 'lookup', pub);
      } catch {
        return found;
      }
      if (!res.ok) return found;
      const body = (await res.json()) as { requests?: Array<{ id: string; amount: number; state: string; received: number; has_payment: boolean; collected: boolean }> };
      const reqs = body.requests ?? [];
      if (!reqs.length && i > last) miss++;
      else miss = 0;
      for (const r of reqs) {
        if (records.some((x) => x.id === r.id)) continue;
        records = [...records, { id: r.id, index: i, pubkey: pub, amount: r.amount, created: Date.now(), state: r.collected ? 'done' : r.has_payment ? 'paid' : 'open', received: r.received }];
        found++;
      }
      if (reqs.length) localStorage.setItem(NEXT, String(Math.max(Number(localStorage.getItem(NEXT) ?? 0), i + 1)));
    }
    if (found) save();
    return found;
  }

  return {
    create,
    collectAll,
    scan,
    records: (): readonly PosRecord[] => records,
    /** Private keys of requests whose pubkey is one of `pubs` (to receive a token handed over by hand). */
    keysFor: (pubs: string[]) => records.filter((r) => pubs.includes(r.pubkey)).map((r) => keyOf(r).priv),
    allKeys: () => records.map((r) => keyOf(r).priv),
    uncollected: () =>
      records.filter((r) => r.state === 'paid' || r.state === 'collecting' || r.state === 'collected' || (r.extras ?? []).some((e) => e.state !== 'done')),
    needsWork: () => records.some(needsWork),
    /** Records that `tokenId` (a sent token) refunded extra payment `n` of request `id`. */
    markRefunded(id: string, n: number, tokenId: string) {
      const ex = records.find((r) => r.id === id)?.extras?.find((e) => e.n === n);
      if (ex) {
        ex.refundId = tokenId;
        save();
      }
    },
  };
}

export type PosRequests = ReturnType<typeof createPosRequests>;

// ---- paying someone else's request (payer side) ----

export type RequestInfo = { id?: string; amount: number; target: string; lockTo?: string; description?: string };

/** Reads a creqA request and checks we can pay it: our mint, our unit, HTTP POST, plain P2PK or no lock. */
export function readRequest(creq: string, mintUrl: string, unit: string): RequestInfo {
  let pr;
  try {
    pr = decodePaymentRequest(creq.trim());
  } catch {
    throw new Error('That is not a payment request (creqA…).');
  }
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  if (pr.unit && pr.unit !== unit) throw new Error(`The request is in ${pr.unit}; this wallet pays ${unit}.`);
  if (pr.mints?.length && !pr.mints.map(norm).includes(norm(mintUrl))) throw new Error(`The request doesn't accept this wallet's mint (${mintUrl}).`);
  const amount = Number(String(pr.amount ?? 0));
  if (!amount) throw new Error('The request has no amount.');
  const target = pr.getTransport('post' as never)?.target;
  if (!target) throw new Error('The request has no HTTP transport this wallet can use.');
  let lockTo: string | undefined;
  if (pr.nut10) {
    if (pr.nut10.kind !== 'P2PK') throw new Error(`The request asks for a ${pr.nut10.kind} lock; this wallet pays plain P2PK locks only.`);
    const tags = (pr.nut10 as { tags?: unknown[] }).tags;
    if (tags && tags.length) throw new Error('The request’s lock has extra conditions; this wallet pays plain P2PK locks only.');
    if (!/^0[23][0-9a-f]{64}$/i.test(pr.nut10.data)) throw new Error('The request’s lock key is not a public key.');
    lockTo = pr.nut10.data.toLowerCase();
  }
  return { id: pr.id, amount, target, lockTo, description: pr.description };
}

/** The proofs as NUT-18 JSON: numeric amounts, DLEQ kept. */
export function payloadProofs(proofs: Proof[]) {
  return proofs.map((p) => ({ id: p.id, amount: Number(String(p.amount)), secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}), ...(p.witness ? { witness: p.witness } : {}) }));
}

/** POSTs a payment to a request's transport. Returns [ok, message]. */
export async function deliver(info: RequestInfo, mintUrl: string, unit: string, proofs: Proof[]): Promise<[boolean, string]> {
  let res: Response;
  try {
    res = await fetch(info.target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: info.id, mint: mintUrl, unit, proofs: payloadProofs(proofs) }),
    });
  } catch {
    return [false, 'The shop’s point of sale is unreachable.'];
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; state?: string; extra?: boolean; partial?: boolean };
  return res.ok ? [true, body.partial ? 'PARTIAL' : body.extra ? 'EXTRA' : (body.state ?? 'PAID')] : [false, body.error ?? `HTTP ${res.status}`];
}

export { getEncodedToken };
