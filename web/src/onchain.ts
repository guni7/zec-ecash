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
import QRCode from 'qrcode';
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
  busy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T | undefined>;
  scan(prompt: string, onResult: (text: string) => void): void;
};

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

/** An address, or a single-payment ZIP-321 URI (zcash:<addr>?amount=<ZEC>&memo=...). */
export function parsePaymentUri(text: string): { address: string; amount?: number; note?: string } {
  const t = text.trim();
  if (!/^zcash:/i.test(t)) return { address: t };
  const q = t.indexOf('?');
  const path = decodeURIComponent(q < 0 ? t.slice(6) : t.slice(6, q));
  const params = new URLSearchParams(q < 0 ? '' : t.slice(q + 1));
  if ([...params.keys()].some((k) => /\.\d+$/.test(k))) {
    throw new Error('This payment URI asks for several payments; this wallet sends one at a time.');
  }
  const address = path || params.get('address') || '';
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
const explorer = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`;

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
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

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const els = {
    depAmount: $<HTMLInputElement>('dep-amount'),
    depBtn: $<HTMLButtonElement>('dep-btn'),
    depLimits: $('dep-limits'),
    deposits: $('deposits'),
    wdAddress: $<HTMLTextAreaElement>('wd-address'),
    wdScan: $<HTMLButtonElement>('wd-scan'),
    wdAmount: $<HTMLInputElement>('wd-amount'),
    wdBtn: $<HTMLButtonElement>('wd-btn'),
    wdLimits: $('wd-limits'),
    wdQuote: $('wd-quote'),
    wdSummary: $('wd-summary'),
    wdAckRow: $('wd-ack-row'),
    wdAck: $<HTMLInputElement>('wd-ack'),
    wdConfirm: $<HTMLButtonElement>('wd-confirm'),
    wdCancel: $<HTMLButtonElement>('wd-cancel'),
    withdrawals: $('withdrawals'),
  };

  // ---- limits (NUT-04 / NUT-05 settings for zec/zat) ----

  type Limit = { min?: number; max?: number };
  let limits: { mint: Limit; melt: Limit } = { mint: {}, melt: {} };

  function setInfo(info: { nuts?: Record<string, { methods?: Array<{ method: string; unit: string; min_amount?: number; max_amount?: number }> }> }) {
    const pick = (nut: string): Limit => {
      const m = info.nuts?.[nut]?.methods?.find((x) => x.method === METHOD && x.unit === ctx.unit);
      return { min: m?.min_amount ?? undefined, max: m?.max_amount ?? undefined };
    };
    limits = { mint: pick('4'), melt: pick('5') };
    const text = (l: Limit) => (l.min || l.max ? `${l.min ?? 1} to ${l.max ?? '∞'} ${ctx.unit}` : '');
    els.depLimits.textContent = text(limits.mint) && `Deposits: ${text(limits.mint)}.`;
    els.wdLimits.textContent = text(limits.melt) && `Withdrawals: ${text(limits.melt)}, plus the network fee.`;
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

  async function createDeposit(amountText: string) {
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
    els.depAmount.value = '';
    render();
    ctx.say(`Deposit quote created: pay exactly ${zatToZec(amount)} ZEC to the address shown. Ecash is minted automatically once it confirms.`, 'ok');
  }

  async function checkDeposit(w: Wallet, d: Deposit) {
    const q = await w.checkMintQuote<ZecMintQuote>(METHOD, d.quote);
    const paid = num(q.amount_paid);
    const issued = num(q.amount_issued);
    if (paid > issued) {
      d.state = 'paid';
      saveDeposits();
      render();
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

  let quoted: { quote: ZecMeltQuote; amount: number; fee: number; address: string } | null = null;

  async function quoteWithdrawal() {
    const uri = parsePaymentUri(els.wdAddress.value);
    if (uri.amount !== undefined && !els.wdAmount.value) els.wdAmount.value = String(uri.amount);
    const amount = parseZat(els.wdAmount.value, 'withdrawal amount');
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
    quoted = { quote: q, amount, fee, address: uri.address };
    const total = amount + fee;
    const balance = sumProofs(ctx.proofs());
    els.wdSummary.textContent =
      `Send ${amount} ${ctx.unit} (${zatToZec(amount)} ZEC) to ${short(uri.address)}. Network fee up to ${fee} ${ctx.unit}; ` +
      `what isn't used comes back as change. Total ${total} ${ctx.unit} of ecash` +
      (balance < total ? `, but your balance is ${balance} ${ctx.unit}.` : '.') +
      (uri.note ? ` ${uri.note}` : '');
    els.wdQuote.hidden = false;
    els.wdAckRow.hidden = !ctx.mainnet;
    els.wdAck.checked = false;
    els.wdConfirm.disabled = ctx.mainnet || balance < total;
    els.wdConfirm.textContent = ctx.mainnet ? 'Send real ZEC' : 'Send ZEC';
  }

  async function confirmWithdrawal() {
    if (!quoted) return;
    const { quote: q, amount, fee, address } = quoted;
    if (ctx.mainnet && !els.wdAck.checked) throw new Error('Tick the box to confirm you are sending real ZEC.');
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
    els.wdQuote.hidden = true;
    els.wdAddress.value = '';
    els.wdAmount.value = '';
    render();
    await sendMelt(w, wd);
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
      render();
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
      render();
    }
  }

  // ---- rendering ----

  const depEls = new Map<string, { root: HTMLElement; state: HTMLElement; pay: HTMLElement; meta: HTMLElement; dismiss: HTMLButtonElement }>();
  const wdEls = new Map<string, { root: HTMLElement; state: HTMLElement; meta: HTMLElement; dismiss: HTMLButtonElement }>();

  function countdown(expiry: number | null) {
    if (!expiry) return '';
    const s = Math.round(expiry - Date.now() / 1000);
    if (s <= 0) return 'expired';
    return `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      ctx.say(`${what} copied.`, 'ok');
    } catch {
      ctx.say(`Copy blocked by the browser: select the ${what.toLowerCase()} text and copy it by hand.`, 'bad');
    }
  }

  function depositEl(d: Deposit) {
    let e = depEls.get(d.quote);
    if (e) return e;
    const uri = zip321(d.address, d.amount);
    const canvas = el('canvas');
    void QRCode.toCanvas(canvas, uri, { errorCorrectionLevel: 'M', margin: 1, width: 260 }).catch(() => (canvas.hidden = true));
    const uriText = el('textarea', { rows: 3, readOnly: true, spellcheck: false, value: uri, className: 'uri' });
    const copyUri = el('button', { type: 'button', textContent: 'Copy payment URI' });
    copyUri.onclick = () => void copy(uri, 'Payment URI');
    const copyAddr = el('button', { type: 'button', textContent: 'Copy address' });
    copyAddr.onclick = () => void copy(d.address, 'Address');
    const pay = el('div', { className: 'pay' }, el('p', { className: 'muted', textContent: `Pay exactly ${zatToZec(d.amount)} ZEC to:` }), canvas, uriText, el('div', { className: 'row' }, copyUri, copyAddr));
    const state = el('span', { className: 'state' });
    const meta = el('div', { className: 'muted' });
    const dismiss = el('button', { type: 'button', textContent: 'Dismiss', className: 'small' });
    dismiss.onclick = () => {
      deposits = deposits.filter((x) => x.quote !== d.quote);
      saveDeposits();
      depEls.get(d.quote)?.root.remove();
      depEls.delete(d.quote);
    };
    const root = el('div', { className: 'item' }, el('div', { className: 'item-head' }, el('strong', { textContent: `Deposit ${d.amount} ${ctx.unit}` }), state), pay, meta, dismiss);
    root.dataset.quote = d.quote;
    e = { root, state, pay, meta, dismiss };
    depEls.set(d.quote, e);
    els.deposits.prepend(root);
    return e;
  }

  function withdrawalEl(wd: Withdrawal) {
    let e = wdEls.get(wd.quote);
    if (e) return e;
    const state = el('span', { className: 'state' });
    const meta = el('div', { className: 'muted' });
    const dismiss = el('button', { type: 'button', textContent: 'Dismiss', className: 'small' });
    dismiss.onclick = () => {
      withdrawals = withdrawals.filter((x) => x.quote !== wd.quote);
      saveWithdrawals();
      wdEls.get(wd.quote)?.root.remove();
      wdEls.delete(wd.quote);
    };
    const head = el('div', { className: 'item-head' }, el('strong', { textContent: `Withdraw ${wd.amount} ${ctx.unit}` }), state);
    const root = el('div', { className: 'item' }, head, el('div', { className: 'muted addr', textContent: `to ${wd.address}` }), meta, dismiss);
    root.dataset.quote = wd.quote;
    e = { root, state, meta, dismiss };
    wdEls.set(wd.quote, e);
    els.withdrawals.prepend(root);
    return e;
  }

  function render() {
    // Newest first: walk oldest to newest, prepending each new element.
    for (const d of [...deposits].reverse()) {
      const e = depositEl(d);
      const [text, cls] = {
        unpaid: ['Waiting for payment', ''],
        paid: ['Paid: minting ecash…', 'ok'],
        expired: ['Expired unpaid', 'bad'],
        done: [`Minted ${d.minted ?? d.amount} ${ctx.unit} ✓`, 'ok'],
      }[d.state];
      e.state.textContent = text;
      e.state.className = `state ${cls}`;
      e.pay.hidden = d.state !== 'unpaid';
      e.dismiss.hidden = d.state !== 'done' && d.state !== 'expired';
      e.root.dataset.state = d.state;
      e.meta.textContent =
        d.state === 'unpaid'
          ? `${countdown(d.expiry)} · credited once the payment has the mint's confirmations${ctx.mainnet ? ' (about 13 minutes on mainnet)' : ''} · quote ${short(d.quote)}`
          : d.state === 'expired'
            ? `Don't pay this address now. Quote ${short(d.quote)}.`
            : `quote ${short(d.quote)}${d.warning ? ` · ${d.warning}` : ''}`;
    }
    for (const wd of [...withdrawals].reverse()) {
      const e = withdrawalEl(wd);
      const [text, cls] = {
        sending: ['Sending…', ''],
        pending: ['Pending', ''],
        paid: ['Paid ✓', 'ok'],
        returned: ['Not sent: ecash returned', 'bad'],
      }[wd.state];
      e.state.textContent = text;
      e.state.className = `state ${cls}`;
      e.root.dataset.state = wd.state;
      e.dismiss.hidden = wd.state !== 'paid' && wd.state !== 'returned';
      e.meta.replaceChildren();
      if (wd.state === 'paid') {
        e.meta.append(`fee ${wd.fee} ${ctx.unit} · change ${wd.change} ${ctx.unit}`);
        if (wd.txid) {
          e.meta.append(el('br'), 'txid ', el('code', { textContent: wd.txid, className: 'txid' }));
          if (ctx.mainnet) e.meta.append(' ', el('a', { href: explorer(wd.txid), target: '_blank', rel: 'noopener', textContent: 'view in explorer' }));
          else e.meta.append(' (regtest: no public explorer)');
        }
        if (wd.note) e.meta.append(el('br'), wd.note);
      } else if (wd.state === 'returned') {
        e.meta.append(wd.note ?? '');
      } else {
        e.meta.append(`${wd.amount + wd.feeReserve} ${ctx.unit} of ecash held for it (fee reserve ${wd.feeReserve}); the guardians sign, then it waits to be mined. Quote ${short(wd.quote)}.`);
      }
    }
  }

  // ---- wiring ----

  els.depBtn.onclick = () => void ctx.busy(els.depBtn, () => createDeposit(els.depAmount.value));
  els.wdBtn.onclick = () => void ctx.busy(els.wdBtn, () => quoteWithdrawal());
  els.wdConfirm.onclick = () => void ctx.busy(els.wdConfirm, () => confirmWithdrawal());
  els.wdCancel.onclick = () => {
    quoted = null;
    els.wdQuote.hidden = true;
  };
  els.wdAck.onchange = () => {
    if (!quoted) return;
    els.wdConfirm.disabled = !els.wdAck.checked || sumProofs(ctx.proofs()) < quoted.amount + quoted.fee;
  };
  // A changed address or amount invalidates the quote shown.
  els.wdAddress.oninput = els.wdAmount.oninput = () => {
    quoted = null;
    els.wdQuote.hidden = true;
  };
  els.wdScan.onclick = () =>
    ctx.scan('Point the camera at a Zcash address or payment QR code.', (text) => {
      els.wdAddress.value = text;
      try {
        const uri = parsePaymentUri(text);
        if (uri.amount !== undefined) els.wdAmount.value = String(uri.amount);
        ctx.say(uri.amount !== undefined ? `Scanned: ${uri.amount} ${ctx.unit} to ${short(uri.address)}. Get a quote to continue.` : 'Address scanned. Enter an amount and get a quote.', 'ok');
      } catch (e) {
        ctx.say(ctx.explain(e), 'bad');
      }
    });

  render();
  setInterval(() => void tick(), POLL_MS);
  setInterval(() => {
    // countdowns
    if (deposits.some((d) => d.state === 'unpaid')) render();
  }, 1000);

  return {
    setInfo,
    /** After (re)connecting: resume everything saved, including expired deposits. */
    resume: () => tick(true),
  };
}
