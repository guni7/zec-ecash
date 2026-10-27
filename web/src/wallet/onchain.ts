// Deposits (ZEC -> ecash) and withdrawals (ecash -> ZEC) over the mint's custom `zec` payment
// method, with cashu-ts's generic method API (createMintQuote / prepareMint / completeMint,
// createMeltQuote / prepareMelt / completeMelt): NUT-04 and NUT-05 with a custom method, NUT-20
// signed mint requests, NUT-08 blank outputs for withdrawal change, NUT-12 DLEQ checks on every
// proof we receive, NUT-09 restore to recover a mint response that was lost.
//
// Everything in flight is in localStorage next to the proofs, written BEFORE each request that
// could move value, so a reload (or a crash) at any point resumes: a paid deposit is always
// minted (re-sending the same outputs, or restoring their signatures if the mint already signed
// them), and a withdrawal is followed until it is paid (change comes back) or refused (its inputs,
// still unspent, come back). Proofs are de-duplicated by secret, so replaying a step never counts
// anything twice.
//
// cdk-mintd 0.18.2 quirks handled here: `zec` mint quotes carry no `state` (paid/issued come from
// amount_paid/amount_issued), melt quote requests must repeat `"method": "zec"` in the body, paid
// melt quotes leave out the change signatures (recovered with NUT-09 restore), and
// a refused quote only says "Invalid payment request" / "Invalid payment method", so the real
// reason comes from zec-processor's /deposit-quote and /withdrawal-quote.
//
// No DOM here: the pages (src/ui/pages/deposit.ts, withdraw.ts) render the saved records and
// subscribe to changes.
import {
  Amount,
  CheckStateEnum,
  MintOperationError,
  OutputData,
  deserializeProofs,
  hasValidDleq,
  type MeltPreview,
  type MeltQuoteBaseResponse,
  type MintPreview,
  type MintQuoteBaseResponse,
  type Proof,
  type SerializedBlindedSignature,
  type SerializedOutputData,
  type Wallet,
} from '@cashu/cashu-ts';
import { loadOrCreateKey } from './offline';

const METHOD = 'zec';
const ZAT_PER_ZEC = 100_000_000;
const POLL_MS = 4000;

export type Ctx = {
  mintUrl: string;
  unit: string;
  mainnet: boolean;
  connect(): Promise<Wallet>;
  proofs(): Proof[];
  /** Replaces the wallet's proofs, saves them and redraws the balance. */
  setProofs(proofs: Proof[]): void;
  say(text: string, kind?: 'ok' | 'bad' | ''): void;
  explain(e: unknown): string;
  isNetworkError(e: unknown): boolean;
};

export type Limit = { min?: number; max?: number };

/** A withdrawal quote waiting for the user's confirmation. */
export type QuotedWithdrawal = { quote: ZecMeltQuote; amount: number; fee: number; address: string; total: number; note?: string };

type ZecMintQuote = MintQuoteBaseResponse & { amount?: Amount | number; expiry?: number | null };
type ZecMeltQuote = MeltQuoteBaseResponse & {
  fee_reserve?: Amount | number;
  request?: string;
  payment_preimage?: string | null;
  change?: SerializedBlindedSignature[];
};

export type Deposit = {
  quote: string;
  amount: number;
  address: string;
  expiry: number | null;
  created: number;
  state: 'unpaid' | 'paid' | 'expired' | 'done';
  /** Outputs (and their NUT-20 signature) of the mint request, saved before it is sent. */
  outputs?: SerializedOutputData[];
  signature?: string;
  minted?: number;
  warning?: string;
};

export type Withdrawal = {
  quote: string;
  amount: number;
  feeReserve: number;
  address: string;
  created: number;
  /** sending: saved, the melt may not have reached the mint yet; pending: the mint has it. */
  state: 'sending' | 'pending' | 'paid' | 'returned';
  /** The proofs being melted (out of the balance while in flight) and the NUT-08 blanks. */
  inputs: unknown[];
  outputs: SerializedOutputData[];
  txid?: string;
  fee?: number;
  change?: number;
  note?: string;
};

// ---- ZIP-321 payment URIs ----

export function zatToZec(zat: number): string {
  const frac = String(zat % ZAT_PER_ZEC).padStart(8, '0').replace(/0+$/, '');
  return `${Math.floor(zat / ZAT_PER_ZEC)}${frac ? `.${frac}` : ''}`;
}

export function zip321(address: string, zat: number): string {
  return `zcash:${address}?amount=${zatToZec(zat)}`;
}

/**
 * A Zcash address as the network expects it. Wallets may show a unified or Sapling address all in
 * uppercase in a QR code (ZIP-316: it lets the code use the denser alphanumeric mode); bech32
 * allows all-upper or all-lower, so that is lowercased. Mixed case (invalid) and transparent
 * addresses (base58, case-sensitive) are left as they are.
 */
export function normalizeAddress(a: string): string {
  const t = a.trim();
  return /^(U1|UTEST1|UREGTEST1|ZS1|ZTESTSAPLING1|ZREGTESTSAPLING1)[0-9A-Z]+$/.test(t) ? t.toLowerCase() : t;
}

/** A scanned address or zcash: link as it should read: an uppercase address (and an uppercase
 * link's scheme and parameter names) in lowercase; parameter values as they are. */
export function normalizePaymentText(text: string): string {
  const t = text.trim();
  if (!/^zcash:/i.test(t)) return normalizeAddress(t);
  const q = t.indexOf('?');
  const addr = normalizeAddress(q < 0 ? t.slice(6) : t.slice(6, q));
  const query = q < 0 ? '' : t.slice(q + 1).replace(/(^|&)([^=&]+)/g, (_, sep: string, k: string) => sep + k.toLowerCase());
  return `zcash:${addr}${q < 0 ? '' : `?${query}`}`;
}

/** An address, or a single-payment ZIP-321 URI (zcash:<addr>?amount=<ZEC>&memo=...). The scheme,
 * the parameter names and an uppercase address may be in uppercase (QR alphanumeric mode). */
export function parsePaymentUri(text: string): { address: string; amount?: number; note?: string } {
  const t = text.trim();
  if (!/^zcash:/i.test(t)) return { address: normalizeAddress(t) };
  const q = t.indexOf('?');
  const path = normalizeAddress(decodeURIComponent(q < 0 ? t.slice(6) : t.slice(6, q)));
  const params = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(q < 0 ? '' : t.slice(q + 1))) params.append(k.toLowerCase(), v);
  if ([...params.keys()].some((k) => /\.\d+$/.test(k))) {
    throw new Error('This payment URI asks for several payments; this wallet sends one at a time.');
  }
  const address = path || normalizeAddress(params.get('address') ?? '');
  if (!address) throw new Error('The payment URI has no address.');
  const amt = params.get('amount');
  let amount: number | undefined;
  if (amt !== null) {
    const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(amt);
    if (!m) throw new Error(`The payment URI's amount "${amt}" is not a ZEC amount.`);
    amount = Number(m[1]) * ZAT_PER_ZEC + Number((m[2] ?? '').padEnd(8, '0'));
  }
  const note = params.has('memo') ? 'The payment URI has a memo; this wallet cannot attach memos, so it is left out.' : undefined;
  return { address, amount, note };
}

// ---- helpers ----

const num = (x: unknown) => Number(String(x ?? 0));
const sumProofs = (ps: Proof[]) => ps.reduce((a, p) => a + num(p.amount), 0);
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-8)}` : s);
export const explorer = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`;

function parseZat(text: string, what: string): number {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n) || n <= 0) throw new Error(`Enter the ${what} as a whole number of zat.`);
  return n;
}

function load<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as T[];
  } catch {
    return [];
  }
}

// ---- the module ----

export function initOnchain(ctx: Ctx) {
  const DEP_KEY = `zec-ecash-demo:deposits:${ctx.mintUrl}`;
  const WD_KEY = `zec-ecash-demo:withdrawals:${ctx.mintUrl}`;
  /** NUT-20: deposit quotes are locked to this key, so only this browser can mint them. */
  const nut20 = loadOrCreateKey(`zec-ecash-demo:nut20-key:${ctx.mintUrl}`);

  let deposits = load<Deposit>(DEP_KEY);
  let withdrawals = load<Withdrawal>(WD_KEY);
  const saveDeposits = () => localStorage.setItem(DEP_KEY, JSON.stringify(deposits));
  const saveWithdrawals = () => localStorage.setItem(WD_KEY, JSON.stringify(withdrawals));
  /** Quotes with a request in flight in this page; the poller leaves them alone. */
  const inFlight = new Set<string>();

  const listeners = new Set<() => void>();
  /** Tells the pages that a deposit or withdrawal changed. */
  const emit = () => listeners.forEach((l) => l());

  // ---- limits (NUT-04 / NUT-05 settings for zec/zat) ----

  let limits: { mint: Limit; melt: Limit } = { mint: {}, melt: {} };

  function setInfo(info: { nuts?: Record<string, { methods?: Array<{ method: string; unit: string; min_amount?: number; max_amount?: number }> }> }) {
    const pick = (nut: string): Limit => {
      const m = info.nuts?.[nut]?.methods?.find((x) => x.method === METHOD && x.unit === ctx.unit);
      return { min: m?.min_amount ?? undefined, max: m?.max_amount ?? undefined };
    };
    limits = { mint: pick('4'), melt: pick('5') };
    emit();
  }

  function checkLimit(amount: number, l: Limit, what: string) {
    if (l.min !== undefined && amount < l.min) throw new Error(`The mint's minimum ${what} is ${l.min} ${ctx.unit}.`);
    if (l.max !== undefined && amount > l.max) throw new Error(`The mint's maximum ${what} is ${l.max} ${ctx.unit}.`);
  }

  /** The mint hides why it refused a quote; zec-processor's status endpoint says. */
  async function refusal(path: string, e: unknown): Promise<string> {
    if (ctx.isNetworkError(e)) return ctx.explain(e);
    try {
      const body = (await (await fetch(path)).json()) as { ok?: boolean; error?: string };
      if (body.ok === false && body.error) return `The mint refused: ${body.error}`;
    } catch {
      /* status endpoint unreachable: fall back to the mint's own words */
    }
    return ctx.explain(e);
  }

  // ---- proofs ----

  /** Adds proofs not already held (by secret), so replayed steps never double count. */
  function addProofs(extra: Proof[]): Proof[] {
    const have = new Set(ctx.proofs().map((p) => p.secret));
    const fresh = extra.filter((p) => !have.has(p.secret));
    if (fresh.length) ctx.setProofs([...ctx.proofs(), ...fresh]);
    return fresh;
  }

  /** NUT-12: every proof the mint signs for us must carry a valid DLEQ proof. */
  function dleqProblem(w: Wallet, ps: Proof[]): string | undefined {
    for (const p of ps) {
      let ok = false;
      try {
        ok = hasValidDleq(p, w.keyChain.getKeyset(p.id), { require: true });
      } catch {
        ok = false;
      }
      if (!ok) return `The mint's signature on a ${num(p.amount)} ${ctx.unit} proof has no valid DLEQ proof; it was kept, but this mint is misbehaving.`;
    }
    return undefined;
  }

  /** NUT-09: signatures the mint already made for these outputs (a response we never got). */
  async function restore(w: Wallet, outputs: SerializedOutputData[]): Promise<Proof[]> {
    const data = outputs.map((o) => OutputData.deserialize(o));
    const res = await w.mint.restore({ outputs: data.map((o) => o.blindedMessage) });
    if (!res.signatures.length) return [];
    const byB = new Map(data.map((o) => [o.blindedMessage.B_, o]));
    const matched = res.outputs.map((o) => byB.get(o.B_)).filter((o): o is OutputData => !!o);
    await w.ensureOperableKeysets(res.signatures.map((s) => s.id));
    return w.createMeltChangeProofs(matched, res.signatures);
  }

  // ---- deposits ----

  async function createDeposit(amountText: string): Promise<Deposit> {
    const amount = parseZat(amountText, 'deposit amount');
    checkLimit(amount, limits.mint, 'deposit');
    const w = await ctx.connect();
    let q: ZecMintQuote;
    try {
      q = await w.createMintQuote<ZecMintQuote>(METHOD, { amount, pubkey: nut20.pub });
    } catch (e) {
      throw new Error(await refusal(`/deposit-quote?amount=${amount}`, e));
    }
    if (q.pubkey && q.pubkey !== nut20.pub) throw new Error('The mint locked the quote to a different key; not using it.');
    if (num(q.amount) !== amount) throw new Error(`The mint quoted ${num(q.amount)} ${ctx.unit}, not ${amount}; not using it.`);
    deposits = [{ quote: q.quote, amount, address: q.request, expiry: q.expiry ?? null, created: Date.now(), state: 'unpaid' }, ...deposits];
    saveDeposits();
    emit();
    ctx.say(`Deposit quote created: pay exactly ${zatToZec(amount)} ZEC to the address shown. Ecash is minted automatically once it confirms.`, 'ok');
    return deposits[0];
  }

  async function checkDeposit(w: Wallet, d: Deposit) {
    const q = await w.checkMintQuote<ZecMintQuote>(METHOD, d.quote);
    const paid = num(q.amount_paid);
    const issued = num(q.amount_issued);
    if (paid > issued) {
      d.state = 'paid';
      saveDeposits();
      emit();
      await mintDeposit(w, d, paid - issued);
    } else if (issued > 0) {
      // Issued: by us just now in a request whose answer was lost, or long ago.
      if (d.outputs) {
        const got = await restore(w, d.outputs);
        if (got.length) finishDeposit(w, d, got);
        else {
          d.state = 'done';
          delete d.outputs;
          saveDeposits();
        }
      } else d.state = 'done';
      saveDeposits();
    } else if (d.expiry && Date.now() / 1000 > d.expiry) {
      if (d.state !== 'expired') ctx.say(`Deposit quote for ${d.amount} ${ctx.unit} expired unpaid. Don't pay its address now.`, 'bad');
      d.state = 'expired';
      saveDeposits();
    }
  }

  async function mintDeposit(w: Wallet, d: Deposit, mintable: number) {
    const outSum = (d.outputs ?? []).reduce((a, o) => a + num(o.blindedMessage.amount), 0);
    let preview: MintPreview<{ quote: string }>;
    if (d.outputs && outSum === mintable) {
      // Same outputs as the earlier attempt: if the mint signed them already it refuses, and
      // restore() below gets the signatures.
      const outputData = d.outputs.map((o) => OutputData.deserialize(o));
      preview = {
        method: METHOD,
        payload: { quote: d.quote, outputs: outputData.map((o) => o.blindedMessage), signature: d.signature },
        outputData,
        keysetId: outputData[0].blindedMessage.id,
        quote: { quote: d.quote },
      };
    } else {
      if (d.outputs) {
        const got = await restore(w, d.outputs);
        if (got.length) addProofs(got);
      }
      preview = await w.prepareMint(METHOD, mintable, { quote: d.quote }, { privkey: nut20.priv });
      d.outputs = preview.outputData.map((o) => OutputData.serialize(o));
      d.signature = preview.payload.signature;
      saveDeposits(); // before the request: whatever happens to it, these can be recovered
    }
    let got: Proof[];
    try {
      got = await w.completeMint(preview);
    } catch (e) {
      if (ctx.isNetworkError(e)) throw e;
      got = await restore(w, d.outputs!);
      if (!got.length) throw e;
    }
    finishDeposit(w, d, got);
  }

  function finishDeposit(w: Wallet, d: Deposit, got: Proof[]) {
    d.warning = dleqProblem(w, got);
    addProofs(got); // proofs first, then the quote is marked done
    d.state = 'done';
    d.minted = sumProofs(got);
    delete d.outputs;
    delete d.signature;
    saveDeposits();
    ctx.say(`Deposit confirmed: minted ${d.minted} ${ctx.unit} of ecash.`, d.warning ? 'bad' : 'ok');
  }

  // ---- withdrawals ----

  let quoted: QuotedWithdrawal | null = null;

  /** `amountText` may be empty when the address is a ZIP-321 URI with an amount. */
  async function quoteWithdrawal(addressText: string, amountText: string): Promise<QuotedWithdrawal> {
    const uri = parsePaymentUri(addressText);
    if (uri.amount !== undefined && !amountText.trim()) amountText = String(uri.amount);
    const amount = parseZat(amountText, 'withdrawal amount');
    checkLimit(amount, limits.melt, 'withdrawal');
    const w = await ctx.connect();
    let q: ZecMeltQuote;
    try {
      q = await w.createMeltQuote<ZecMeltQuote>(METHOD, { method: METHOD, request: uri.address, amount });
    } catch (e) {
      throw new Error(await refusal(`/withdrawal-quote?amount=${amount}&address=${encodeURIComponent(uri.address)}`, e));
    }
    if (num(q.amount) !== amount) throw new Error(`The mint quoted ${num(q.amount)} ${ctx.unit}, not ${amount}; not using it.`);
    const fee = num(q.fee_reserve);
    quoted = { quote: q, amount, fee, address: uri.address, total: amount + fee, note: uri.note };
    return quoted;
  }

  /** `ack`: on mainnet, the user ticked "this sends real ZEC". */
  async function confirmWithdrawal(ack: boolean): Promise<Withdrawal | undefined> {
    if (!quoted) return;
    const { quote: q, amount, fee, address } = quoted;
    if (ctx.mainnet && !ack) throw new Error('Tick the box to confirm you are sending real ZEC.');
    if (q.expiry && Date.now() / 1000 > q.expiry - 15) throw new Error('This quote has expired; get a new one.');
    const w = await ctx.connect();
    // Inputs covering amount + fee reserve (+ input fees); the mint returns the rest as NUT-08 change.
    const { send: inputs } = w.selectProofsToSend(ctx.proofs(), amount + fee, true);
    if (!inputs.length) throw new Error(`Not enough ecash: need ${amount + fee} ${ctx.unit}, balance is ${sumProofs(ctx.proofs())} ${ctx.unit}.`);
    const preview = await w.prepareMelt(METHOD, { quote: q.quote, amount: Amount.from(amount) }, inputs);
    const wd: Withdrawal = {
      quote: q.quote,
      amount,
      feeReserve: fee,
      address,
      created: Date.now(),
      state: 'sending',
      inputs: JSON.parse(JSON.stringify(preview.inputs)),
      outputs: preview.outputData.map((o) => OutputData.serialize(o)),
    };
    // The record (holding the inputs) is saved before the inputs leave the balance.
    withdrawals = [wd, ...withdrawals];
    saveWithdrawals();
    const gone = new Set(preview.inputs.map((p) => p.secret));
    ctx.setProofs(ctx.proofs().filter((p) => !gone.has(p.secret)));
    quoted = null;
    emit();
    await sendMelt(w, wd);
    return wd;
  }

  async function sendMelt(w: Wallet, wd: Withdrawal) {
    const inputs = deserializeProofs(wd.inputs as never);
    const outputData = wd.outputs.map((o) => OutputData.deserialize(o));
    const preview: MeltPreview<{ quote: string; amount: Amount }> = {
      method: METHOD,
      inputs,
      outputData,
      keysetId: outputData[0]?.blindedMessage.id ?? inputs[0].id,
      quote: { quote: wd.quote, amount: Amount.from(wd.amount) },
    };
    inFlight.add(wd.quote);
    try {
      const res = await w.completeMelt(preview, undefined, { preferAsync: true });
      const state = (res.quote as Partial<ZecMeltQuote>).state;
      if (state === 'PAID') return await finishWithdrawal(w, wd, res.quote as ZecMeltQuote, res.change);
      wd.state = 'pending';
      saveWithdrawals();
      ctx.say(`Withdrawal of ${wd.amount} ${ctx.unit} is pending: the guardians sign it and it is broadcast, then it waits to be mined.`, 'ok');
    } catch (e) {
      if (ctx.isNetworkError(e)) {
        // Unknown whether it arrived: the poller asks the mint.
        ctx.say(`Withdrawal sent, but the connection dropped before the mint answered. It is saved and tracked here until it settles.`, 'bad');
        return;
      }
      await settleRefused(w, wd, ctx.explain(e));
    } finally {
      inFlight.delete(wd.quote);
      emit();
    }
  }

  async function checkWithdrawal(w: Wallet, wd: Withdrawal) {
    const q = await w.checkMeltQuote<ZecMeltQuote>(METHOD, wd.quote);
    if (q.state === 'PAID') {
      let change: Proof[] = [];
      if (q.change?.length) {
        await w.ensureOperableKeysets(q.change.map((s) => s.id));
        change = w.createMeltChangeProofs(wd.outputs.map((o) => OutputData.deserialize(o)), q.change);
      }
      await finishWithdrawal(w, wd, q, change);
    } else if (q.state === 'UNPAID') {
      // 'sending': saved, but the page went away before the melt reached the mint: send it now
      // (same inputs and outputs). 'pending' and back to UNPAID: the payment failed.
      if (wd.state === 'sending') await sendMelt(w, wd);
      else await settleRefused(w, wd, 'The withdrawal failed at the mint.');
    } else if (wd.state === 'sending') {
      wd.state = 'pending';
      saveWithdrawals();
    }
  }

  /** The melt was refused or failed: give the inputs back only if the mint says they're unspent. */
  async function settleRefused(w: Wallet, wd: Withdrawal, reason: string) {
    const inputs = deserializeProofs(wd.inputs as never);
    const states = await w.checkProofsStates(inputs);
    if (states.every((s) => s.state === CheckStateEnum.UNSPENT)) {
      addProofs(inputs);
      wd.state = 'returned';
      wd.note = reason;
      wd.inputs = [];
      wd.outputs = [];
      saveWithdrawals();
      ctx.say(`Withdrawal not sent: ${reason} The ${sumProofs(inputs)} ${ctx.unit} are back in your balance.`, 'bad');
    } else {
      // Spent or pending at the mint: the payment is still going; keep following it.
      wd.state = 'pending';
      saveWithdrawals();
    }
  }

  async function finishWithdrawal(w: Wallet, wd: Withdrawal, q: ZecMeltQuote, change: Proof[]) {
    // cdk-mintd 0.18.2 signs the NUT-08 blanks but leaves `change` out of `zec` melt quote
    // responses; the signatures are recovered from the blanks with NUT-09 restore.
    if (!change.length && wd.outputs.length) change = await restore(w, wd.outputs);
    const warning = dleqProblem(w, change);
    addProofs(change); // change first, then the withdrawal is marked paid
    const spent = sumProofs(deserializeProofs(wd.inputs as never));
    wd.change = sumProofs(change);
    wd.fee = spent - wd.amount - wd.change;
    wd.txid = q.payment_preimage ?? undefined;
    wd.state = 'paid';
    wd.note = warning;
    wd.inputs = [];
    wd.outputs = [];
    saveWithdrawals();
    ctx.say(`Withdrawal paid: ${wd.amount} ${ctx.unit} sent${wd.txid ? ` in ${short(wd.txid)}` : ''}; fee ${wd.fee} ${ctx.unit}, change ${wd.change} ${ctx.unit}.`, warning ? 'bad' : 'ok');
  }

  // ---- polling and resume ----

  let ticking = false;

  /** One pass over everything open. `all` also rechecks expired deposits (on load). */
  async function tick(all = false) {
    if (ticking) return;
    ticking = true;
    try {
      const open = deposits.filter((d) => d.state === 'unpaid' || d.state === 'paid' || (all && d.state === 'expired'));
      const moving = withdrawals.filter((x) => x.state === 'sending' || x.state === 'pending');
      if (!open.length && !moving.length) return;
      const w = await ctx.connect();
      for (const d of open) {
        if (inFlight.has(d.quote)) continue;
        inFlight.add(d.quote);
        try {
          await checkDeposit(w, d);
        } catch (e) {
          if (!ctx.isNetworkError(e)) ctx.say(`Deposit ${short(d.quote)}: ${ctx.explain(e)} (will retry)`, 'bad');
        } finally {
          inFlight.delete(d.quote);
        }
      }
      for (const wd of moving) {
        if (inFlight.has(wd.quote)) continue;
        try {
          await checkWithdrawal(w, wd);
        } catch (e) {
          if (!ctx.isNetworkError(e)) ctx.say(`Withdrawal ${short(wd.quote)}: ${ctx.explain(e)} (will retry)`, 'bad');
        }
      }
    } catch {
      /* mint unreachable: everything stays saved; next tick */
    } finally {
      ticking = false;
      emit();
    }
  }

  setInterval(() => void tick(), POLL_MS);

  return {
    setInfo,
    /** After (re)connecting: resume everything saved, including expired deposits. */
    resume: () => tick(true),
    /** One poll pass now (e.g. when a page opens). */
    tick: () => tick(),
    createDeposit,
    quoteWithdrawal,
    confirmWithdrawal,
    cancelQuote: () => {
      quoted = null;
    },
    deposits: (): readonly Deposit[] => deposits,
    withdrawals: (): readonly Withdrawal[] => withdrawals,
    limits: () => limits,
    /** Calls `fn` after every change to a deposit or withdrawal; returns the unsubscribe. */
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
