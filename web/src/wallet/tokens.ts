// Ecash tokens: receive (online, or offline for P2PK-locked tokens with DLEQ), send (optionally
// locked to a recipient), and the sent-token ledger (pending -> received, or reclaimed). No DOM.
import { CheckStateEnum, getEncodedToken, getTokenMetadata, type Proof } from '@cashu/cashu-ts';
import { loadJson, reviveProofs, saveJson, sumAmounts, type Core } from './core';
import { loadPending, savePending, verifyOffline, type PendingReceipt } from './offline';
import { checkOpen, deliver, readRequest, type RequestInfo } from './posreq';

export type SentToken = {
  id: string;
  token: string;
  amount: number;
  at: number;
  state: 'pending' | 'received' | 'reclaimed';
  /** Recipient pubkey when P2PK-locked (then only they can redeem; no reclaim). */
  lockedTo?: string;
  compact: boolean;
  /** The proofs inside the token (for state checks and reclaim). */
  proofs: unknown[];
  /** Paid to a NUT-18 request: where it was (or is to be) delivered, and the last refusal. */
  request?: RequestInfo;
  deliveryError?: string;
};

export type Received = { id: string; amount: number; at: number; how: 'online' | 'offline' | 'redeemed-offline' | 'reclaim' };

const normalizeMint = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** `extraKeys`: private keys this wallet also holds (its point-of-sale request keys). */
export function createTokens(core: Core, extraKeys: () => string[] = () => []) {
  const SENT = core.key('sent');
  const RECEIVED = core.key('received');
  const PENDING = core.key('offline-received');
  let sent = loadJson<SentToken[]>(SENT, []);
  let received = loadJson<Received[]>(RECEIVED, []);
  let pending: PendingReceipt[] = loadPending(PENDING);

  // The single-page wallet kept only the last token sent: carry it over once.
  const legacy = localStorage.getItem(core.key('last-sent'));
  if (legacy && !sent.some((s) => s.token === legacy)) {
    try {
      const meta = getTokenMetadata(legacy);
      sent = [{ id: newId(), token: legacy, amount: Number(String(meta.amount)), at: Date.now(), state: 'pending', compact: true, proofs: [] }, ...sent];
      saveJson(SENT, sent);
    } catch {
      /* not a token: ignore */
    }
  }

  const saveSent = () => {
    saveJson(SENT, sent);
    core.emit({ type: 'sent' });
  };
  const logReceived = (amount: number, how: Received['how']) => {
    received = [{ id: newId(), amount, at: Date.now(), how }, ...received].slice(0, 500);
    saveJson(RECEIVED, received);
    core.emit({ type: 'activity' });
  };
  const addProofs = (extra: Proof[]) => {
    const have = new Set(core.proofs().map((p) => p.secret));
    core.setProofs([...core.proofs(), ...extra.filter((p) => !have.has(p.secret))]);
  };

  /** Redeems a token at the mint; with no network, accepts it offline only if verifyOffline proves it safe. */
  async function receive(token: string): Promise<{ amount: number; offline: boolean }> {
    token = token.trim();
    if (!token) throw new Error('Paste or scan a token first.');
    let meta;
    try {
      meta = getTokenMetadata(token);
    } catch {
      throw new Error('That is not a Cashu token.');
    }
    if (meta.unit !== core.unit) throw new Error(`Wrong unit: this token is in ${meta.unit}; this wallet only takes ${core.unit}.`);
    if (normalizeMint(meta.mint) !== normalizeMint(core.mintUrl)) {
      throw new Error(`Wrong mint: this token is from ${meta.mint}; this wallet uses ${core.mintUrl}.`);
    }
    let got: Proof[];
    try {
      const w = await core.connect();
      // privkey: signs for proofs P2PK-locked to this wallet's key or one of its request keys
      // (a payment handed over by hand); ignored for unlocked ones.
      got = await w.receive(token, { privkey: [core.me.priv, ...extraKeys()] });
    } catch (e) {
      if (core.isNetworkError(e)) return { amount: acceptOffline(token), offline: true };
      throw e;
    }
    addProofs(got);
    const amount = sumAmounts(got);
    // Our own pending token coming back counts as reclaimed.
    const mine = sent.find((s) => s.token === token && s.state === 'pending');
    if (mine) {
      mine.state = 'reclaimed';
      saveSent();
    }
    logReceived(amount, mine ? 'reclaim' : 'online');
    return { amount, offline: false };
  }

  /** No mint: accept only what verifyOffline proves safe, and queue it for redemption. */
  function acceptOffline(token: string): number {
    const verdict = verifyOffline(token, core.cachedKeychain(), core.mintUrl, core.unit, core.me.pub);
    if (!verdict.ok) throw new Error(`Offline, not accepted: ${verdict.reason}`);
    if (pending.some((p) => p.token === token)) throw new Error('This token is already waiting to be redeemed.');
    pending = [...pending, { token, amount: verdict.amount, at: Date.now() }];
    savePending(PENDING, pending);
    logReceived(verdict.amount, 'offline');
    core.emit({ type: 'balance' });
    return verdict.amount;
  }

  let redeeming = false;
  /** Redeems queued offline receipts; keeps them queued while the mint is unreachable. */
  async function redeemPending() {
    if (redeeming || pending.length === 0) return;
    redeeming = true;
    try {
      const w = await core.connect();
      for (const p of [...pending]) {
        try {
          const got = await w.receive(p.token, { privkey: core.me.priv });
          addProofs(got);
          core.say(`Redeemed ${p.amount} ${core.unit} accepted offline.`, 'ok');
          logReceived(p.amount, 'redeemed-offline');
        } catch (e) {
          if (core.isNetworkError(e)) return; // still offline: try again later
          core.say(`An offline-accepted token could not be redeemed: ${core.explain(e)}`, 'bad');
        }
        pending = pending.filter((q) => q.token !== p.token);
        savePending(PENDING, pending);
        core.emit({ type: 'balance' });
      }
    } catch {
      /* mint unreachable: keep the queue */
    } finally {
      redeeming = false;
    }
  }

  /** Creates a token. Locked tokens always carry DLEQ proofs, so the recipient can accept them offline. */
  async function send(amount: number, opts: { compact: boolean; lockTo?: string }): Promise<SentToken> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
    const lockTo = opts.lockTo?.trim().toLowerCase();
    if (lockTo && !/^0[23][0-9a-f]{64}$/.test(lockTo)) throw new Error("That isn't a public key (66 hex characters starting 02 or 03).");
    const balance = core.balance();
    if (balance < amount) throw new Error(`Not enough ecash: balance is ${balance} ${core.unit}.`);
    const w = await core.connect();
    const { keep, send: out } = lockTo
      ? await w.send(amount, core.proofs(), undefined, { send: { type: 'p2pk', options: { pubkey: lockTo } } })
      : await w.send(amount, core.proofs());
    const compact = opts.compact && !lockTo;
    // Compact drops the DLEQ proofs (NUT-12): about half the size, but no offline check for the receiver.
    const token = getEncodedToken({ mint: core.mintUrl, unit: core.unit, proofs: out }, { removeDleq: compact });
    const item: SentToken = { id: newId(), token, amount, at: Date.now(), state: 'pending', lockedTo: lockTo, compact, proofs: JSON.parse(JSON.stringify(out)) };
    // The token is saved before the proofs leave the balance.
    sent = [item, ...sent];
    saveSent();
    core.setProofs(keep);
    return item;
  }

  /** Pays a NUT-18 request: proofs P2PK-locked to the request's key (with DLEQ proofs, no
   * locktime or refund), saved as a sent token before they leave the balance, then delivered. */
  async function payRequest(creq: string): Promise<{ item: SentToken; ok: boolean; message: string }> {
    const info = readRequest(creq, core.mintUrl, core.unit);
    const balance = core.balance();
    if (balance < info.amount) throw new Error(`Not enough ecash: the request is for ${info.amount} ${core.unit}, balance is ${balance}.`);
    await checkOpen(info); // expired or cancelled: nothing leaves the wallet
    const w = await core.connect();
    const { keep, send: out } = info.lockTo
      ? await w.send(info.amount, core.proofs(), undefined, { send: { type: 'p2pk', options: { pubkey: info.lockTo } } })
      : await w.send(info.amount, core.proofs());
    const token = getEncodedToken({ mint: core.mintUrl, unit: core.unit, proofs: out });
    const item: SentToken = { id: newId(), token, amount: info.amount, at: Date.now(), state: 'pending', lockedTo: info.lockTo, compact: false, proofs: JSON.parse(JSON.stringify(out)), request: info };
    sent = [item, ...sent];
    saveSent();
    core.setProofs(keep);
    return { item, ...(await redeliver(item.id)) };
  }

  /** Delivers (again) a token paid to a request. */
  async function redeliver(id: string): Promise<{ ok: boolean; message: string }> {
    const s = sent.find((x) => x.id === id);
    if (!s?.request) throw new Error('This token was not paid to a request.');
    const [ok, message] = await deliver(s.request, core.mintUrl, core.unit, reviveProofs(s.proofs));
    if (ok) {
      s.state = 'received';
      delete s.deliveryError;
    } else s.deliveryError = message;
    saveSent();
    return { ok, message };
  }

  /** Asks the mint whether the recipient has redeemed it yet. */
  async function refresh(id: string): Promise<SentToken | undefined> {
    const s = sent.find((x) => x.id === id);
    if (!s || s.state !== 'pending' || !s.proofs.length) return s;
    const w = await core.connect();
    const states = await w.checkProofsStates(reviveProofs(s.proofs));
    if (states.length && states.every((st) => st.state === CheckStateEnum.SPENT)) {
      s.state = 'received';
      saveSent();
    }
    return s;
  }

  function markReceived(id: string) {
    const s = sent.find((x) => x.id === id);
    if (s && s.state === 'pending') {
      s.state = 'received';
      saveSent();
    }
  }

  /** Takes an unredeemed (unlocked) token back: swaps its proofs into new ones, which voids it. */
  async function reclaim(id: string): Promise<number> {
    const s = sent.find((x) => x.id === id);
    if (!s) throw new Error('No such token.');
    if (s.lockedTo) throw new Error('This token is locked to the recipient; only they can redeem it.');
    if (s.state !== 'pending') throw new Error(`This token was already ${s.state}.`);
    try {
      return (await receive(s.token)).amount;
    } catch (e) {
      if (/already spent/i.test(core.explain(e))) {
        s.state = 'received';
        saveSent();
        throw new Error('The recipient already redeemed it, so there is nothing to reclaim. Marked as received.');
      }
      throw e;
    }
  }

  return {
    receive,
    redeemPending,
    send,
    payRequest,
    redeliver,
    refresh,
    markReceived,
    reclaim,
    sent: (): readonly SentToken[] => sent,
    received: (): readonly Received[] => received,
    pendingOffline: (): readonly PendingReceipt[] => pending,
    pendingOfflineZat: () => pending.reduce((a, p) => a + p.amount, 0),
  };
}

export type Tokens = ReturnType<typeof createTokens>;
