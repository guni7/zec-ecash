// Shop mode's data and arithmetic: the shop profile, catalogue, invoices, totals and tax, the
// state of an invoice from its payment requests (posreq.ts records), sales figures for the
// dashboard, and CSV. Pure: no DOM, no storage, so the unit tests run it directly.
//
// Money is whole zats throughout. An invoice is paid through one or more locked NUT-18 requests
// (the first for the total; "wait for the rest" adds one for what is still owed); their
// payments, extras and partials (posreq.ts) are the invoice's payments. Payments the server
// received after the invoice expired or its request was cancelled are "late": they don't pay it
// and can be refunded. Times are the server's (when it received each payment), so a phone that
// was offline at the time doesn't take an on-time payment for a late one.
import type { PosRecord } from '../wallet/posreq';

export type Profile = {
  name: string;
  address?: string;
  taxId?: string;
  contact?: string;
  /** A small image as a data: URL, for invoices and PDFs (never in links). */
  logo?: string;
  prefix: string;
  /** Tax rate in percent; none if unset or 0. */
  taxRate?: number;
  taxIncluded: boolean;
  footer?: string;
  counterExpiryMin: number;
  sentExpiryDays: number;
  /** Seconds the counter's Paid screen stays before the next sale; 0 to stay. */
  autoReturnSec: number;
};

export const DEFAULT_PROFILE: Profile = { name: '', prefix: 'INV-', taxIncluded: true, footer: 'Thank you!', counterExpiryMin: 15, sentExpiryDays: 7, autoReturnSec: 5 };

export type Item = { id: string; name: string; price: number; category?: string; archived?: boolean };

export type Line = { desc: string; qty: number; unit: number; itemId?: string };

/** `late`: it returned a late payment (one that didn't pay the invoice); `ref`: which payment
 * ("<request>:<n>" or "<request>:main"), if it returned one payment. */
export type Refund = { at: number; amount: number; tokenId: string; what: string; late?: boolean; ref?: string };

export type Invoice = {
  id: string;
  kind: 'counter' | 'sent';
  /** "INV-0001", from `seq`; set on Issue. */
  number?: string;
  seq?: number;
  customer?: { name?: string; email?: string };
  lines: Line[];
  note?: string;
  taxRate?: number;
  taxIncluded: boolean;
  createdAt: number;
  issuedAt?: number;
  expiresAt?: number;
  cancelledAt?: number;
  /** The shop took a short payment as full payment. */
  acceptedShortAt?: number;
  /** Payment requests (posreq record ids), oldest first. */
  requests: string[];
  /** The newest request as shown to payers: the server's, with the invoice number as description. */
  creq?: string;
  refunds: Refund[];
  history: Array<{ at: number; what: string }>;
};

export type State = 'draft' | 'open' | 'partial' | 'paid' | 'overpaid' | 'expired' | 'cancelled' | 'refunded' | 'part-refunded';

export const STATE_LABEL: Record<State, string> = {
  draft: 'Draft',
  open: 'Open',
  partial: 'Partially paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  'part-refunded': 'Partly refunded',
};

/** "INV-0007" */
export const formatNumber = (prefix: string, seq: number) => `${prefix}${String(seq).padStart(4, '0')}`;

/** Subtotal, tax and total in whole zats (tax rounded half up). Prices include tax or tax is added. */
export function totals(lines: readonly Line[], taxRate = 0, included = true): { subtotal: number; tax: number; total: number } {
  const sum = lines.reduce((a, l) => a + Math.round(l.qty * l.unit), 0);
  if (!taxRate) return { subtotal: sum, tax: 0, total: sum };
  if (included) {
    const tax = Math.round(sum - sum / (1 + taxRate / 100));
    return { subtotal: sum - tax, tax, total: sum };
  }
  const tax = Math.round((sum * taxRate) / 100);
  return { subtotal: sum, tax, total: sum + tax };
}

export const invoiceTotals = (inv: Pick<Invoice, 'lines' | 'taxRate' | 'taxIncluded'>) => totals(inv.lines, inv.taxRate, inv.taxIncluded);

export type Payment = {
  request: string;
  /** 'payment': a request paid in full; 'partial': short of its request; 'extra': after it was paid. */
  kind: 'payment' | 'partial' | 'extra';
  n?: number;
  amount: number;
  at: number;
  /** In this wallet already (collected), or still being collected. */
  collected: boolean;
  /** Received (server time) after the invoice expired or its request closed: doesn't pay it; refundable. */
  late: boolean;
  /** Refunded as an extra or partial payment (posreq's refundId). */
  refundId?: string;
};

/** Every payment to the invoice's requests, oldest first. */
export function payments(inv: Invoice, records: readonly PosRecord[]): Payment[] {
  const out: Payment[] = [];
  for (const id of inv.requests) {
    const r = records.find((x) => x.id === id);
    if (!r) continue;
    // the server's cancel time if it has one, else this phone's (a cancel it couldn't send)
    const cutoff = Math.min(r.cancelledAt ?? inv.cancelledAt ?? Infinity, inv.expiresAt ?? Infinity);
    if (r.state !== 'open') {
      const at = r.paidAt ?? r.created;
      out.push({ request: id, kind: 'payment', amount: r.collected ?? r.received ?? r.amount, at, collected: r.state === 'collected' || r.state === 'done', late: at > cutoff });
    }
    for (const x of r.extras ?? []) {
      out.push({ request: id, kind: x.kind === 'partial' ? 'partial' : 'extra', n: x.n, amount: x.collected ?? x.received, at: x.at, collected: x.state === 'collected' || x.state === 'done', late: x.kind === 'late' || x.at > cutoff, refundId: x.refundId });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What was paid toward the invoice (not late), refunded, and still owed. */
export function balance(inv: Invoice, pays: readonly Payment[]) {
  const total = invoiceTotals(inv).total;
  const paid = pays.filter((p) => !p.late).reduce((a, p) => a + p.amount, 0);
  const late = pays.filter((p) => p.late).reduce((a, p) => a + p.amount, 0);
  // Refunds of payments toward the invoice; those made outside the shop pages (Receive) count too.
  const refunded =
    inv.refunds.filter((r) => !r.late).reduce((a, r) => a + r.amount, 0) +
    pays.filter((p) => p.refundId && !p.late && !inv.refunds.some((r) => r.tokenId === p.refundId)).reduce((a, p) => a + p.amount, 0);
  return { total, paid, late, refunded, owed: Math.max(0, total - paid) };
}

/** The invoice's state now. */
export function stateOf(inv: Invoice, pays: readonly Payment[], now = Date.now()): State {
  if (!inv.issuedAt) return 'draft';
  const { total, paid, refunded } = balance(inv, pays);
  if (refunded > 0 && paid > 0) {
    const kept = paid - refunded;
    // Refunding only what was paid too much leaves it paid.
    if (kept >= total) return 'paid';
    return kept <= 0 ? 'refunded' : 'part-refunded';
  }
  if (paid > total) return 'overpaid';
  if (paid >= total || (paid > 0 && inv.acceptedShortAt)) return 'paid';
  if (inv.cancelledAt) return 'cancelled';
  if (inv.expiresAt && now > inv.expiresAt) return 'expired';
  return paid > 0 ? 'partial' : 'open';
}

/** When it was paid in full (the payment that completed it), or undefined. */
export function paidAt(inv: Invoice, pays: readonly Payment[]): number | undefined {
  const total = invoiceTotals(inv).total;
  let sum = 0;
  for (const p of pays) {
    if (p.late) continue;
    sum += p.amount;
    if (sum >= total) return p.at;
  }
  return inv.acceptedShortAt;
}

// ---- dashboard ----

export type Period = { from: number; to: number };

export const DAY = 86_400_000;
export const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The start of the next calendar day. */
export const nextDay = (t: number) => {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

export type Row = { inv: Invoice; pays: Payment[]; state: State; paidAt?: number } & ReturnType<typeof balance>;

export function rows(invoices: readonly Invoice[], records: readonly PosRecord[], now = Date.now()): Row[] {
  return invoices.map((inv) => {
    const pays = payments(inv, records);
    return { inv, pays, state: stateOf(inv, pays, now), paidAt: paidAt(inv, pays), ...balance(inv, pays) };
  });
}

const SOLD: State[] = ['paid', 'overpaid', 'part-refunded'];

/** Figures for a period: sales by the day they were paid; open totals as of now. */
export function sales(all: readonly Row[], period: Period) {
  const sold = all.filter((r) => r.paidAt !== undefined && r.paidAt >= period.from && r.paidAt < period.to && (SOLD.includes(r.state) || r.state === 'refunded'));
  const net = (r: Row) => Math.max(0, r.paid - r.refunded);
  const total = sold.reduce((a, r) => a + net(r), 0);
  const counted = sold.filter((r) => r.state !== 'refunded');
  const refunds = all.flatMap((r) => [
    ...r.inv.refunds.filter((f) => f.at >= period.from && f.at < period.to).map((f) => ({ number: r.inv.number, ...f })),
  ]);
  const days: Array<{ day: number; total: number; count: number }> = [];
  // Calendar days (so a 23- or 25-hour day is still one day).
  for (let s = startOfDay(period.from); s < period.to; s = nextDay(s)) {
    const inDay = sold.filter((r) => startOfDay(r.paidAt!) === s);
    days.push({ day: s, total: inDay.reduce((a, r) => a + net(r), 0), count: inDay.length });
  }
  const items = new Map<string, { name: string; revenue: number; qty: number }>();
  for (const r of counted) {
    for (const l of r.inv.lines) {
      const k = l.itemId ?? `free:${l.desc}`;
      const it = items.get(k) ?? { name: l.desc, revenue: 0, qty: 0 };
      it.revenue += Math.round(l.qty * l.unit);
      it.qty += l.qty;
      items.set(k, it);
    }
  }
  const issued = all.filter((r) => r.inv.issuedAt !== undefined && r.inv.issuedAt >= period.from && r.inv.issuedAt < period.to);
  const byState = new Map<State, number>();
  for (const r of issued) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
  const open = all.filter((r) => r.state === 'open' || r.state === 'partial');
  const kind = (k: Invoice['kind']) => counted.filter((r) => r.inv.kind === k).reduce((a, r) => a + net(r), 0);
  return {
    total,
    count: counted.length,
    average: counted.length ? Math.round(total / counted.length) : 0,
    openTotal: open.reduce((a, r) => a + r.owed, 0),
    openCount: open.length,
    refunds: refunds.reduce((a, f) => a + f.amount, 0),
    refundList: refunds,
    days,
    topItems: [...items.values()].sort((a, b) => b.revenue - a.revenue),
    byState,
    counter: kind('counter'),
    sent: kind('sent'),
    sold,
  };
}

// ---- CSV ----

const cell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
const csv = (head: string[], body: unknown[][]) => [head, ...body].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const iso = (t?: number) => (t ? new Date(t).toISOString() : '');

/** One row per invoice. Amounts in zats. Cells starting = + - @ are quoted with ' (no formulas). */
export function invoicesCsv(list: readonly Row[]): string {
  return csv(
    ['number', 'kind', 'state', 'customer', 'email', 'issued', 'expires', 'paid_at', 'subtotal_zats', 'tax_zats', 'total_zats', 'paid_zats', 'refunded_zats', 'late_zats', 'note'],
    list.map((r) => {
      const t = invoiceTotals(r.inv);
      return [r.inv.number ?? '(draft)', r.inv.kind, r.state, r.inv.customer?.name, r.inv.customer?.email, iso(r.inv.issuedAt), iso(r.inv.expiresAt), iso(r.paidAt), t.subtotal, t.tax, t.total, r.paid, r.refunded, r.late, r.inv.note];
    }),
  );
}

/** One row per line item. */
export function linesCsv(list: readonly Row[]): string {
  return csv(
    ['number', 'state', 'issued', 'description', 'quantity', 'unit_zats', 'amount_zats', 'tax_rate_pct', 'prices_include_tax'],
    list.flatMap((r) => r.inv.lines.map((l) => [r.inv.number ?? '(draft)', r.state, iso(r.inv.issuedAt), l.desc, l.qty, l.unit, Math.round(l.qty * l.unit), r.inv.taxRate ?? 0, r.inv.taxIncluded ? 'yes' : 'no'])),
  );
}

/** Search: number, customer, note and item text. */
export function matches(inv: Invoice, q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [inv.number, inv.customer?.name, inv.customer?.email, inv.note, ...inv.lines.map((l) => l.desc)].some((x) => x?.toLowerCase().includes(s));
}
