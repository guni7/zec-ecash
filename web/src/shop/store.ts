// Shop data on this device (IndexedDB): the profile, the catalogue and the invoices, kept in
// memory once loaded and written through on every change. The invoice counter lives in its own
// database, which a wallet reset or "delete shop data" never touches, so a number is never
// reused; it is advanced and saved before the number is used.
//
// Payments go through the wallet's own payment requests (posreq.ts: a fresh locked key per
// request, auto-collect, extras, partials) and refunds through tokens.ts, both unchanged.
import type { Core } from '../wallet/core';
import { deriveKey, type PosRecord, type PosRequests } from '../wallet/posreq';
import type { Tokens, SentToken } from '../wallet/tokens';
import { pack, type InvoiceDoc, type ReceiptDoc, type ShopInfo } from './link';
import { DAY, DEFAULT_PROFILE, formatNumber, invoiceTotals, paidAt, payments, rows, type Invoice, type Item, type Line, type Profile } from './model';

const COUNTERS = 'zec-ecash-shop-counters';

function idb<T = unknown>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function openDb(name: string, stores: Array<[string, string | null]>): Promise<IDBDatabase> {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => {
    for (const [s, key] of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, key ? { keyPath: key } : undefined);
  };
  return idb(r);
}

const tx = (db: IDBDatabase, store: string, mode: IDBTransactionMode = 'readonly') => db.transaction(store, mode).objectStore(store);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Everything the shop holds, as in a backup or "Export shop data". */
export type ShopDump = { format: 'zec-ecash-shop'; version: 1; mintUrl: string; profile: Profile | null; items: Item[]; invoices: Invoice[]; seq: number };

export async function openShop(core: Core, posreq: PosRequests, tokens: Tokens) {
  const db = await openDb(`zec-ecash-shop:${core.mintUrl}`, [
    ['kv', null],
    ['items', 'id'],
    ['invoices', 'id'],
  ]);
  const cdb = await openDb(COUNTERS, [['seq', null]]);
  let profile = ((await idb(tx(db, 'kv').get('profile'))) as Profile | undefined) ?? null;
  let items = ((await idb(tx(db, 'items').getAll())) as Item[]).sort((a, b) => a.name.localeCompare(b.name));
  let invoices = ((await idb(tx(db, 'invoices').getAll())) as Invoice[]).sort((a, b) => b.createdAt - a.createdAt);
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());

  async function putInvoice(inv: Invoice) {
    await idb(tx(db, 'invoices', 'readwrite').put(inv));
    invoices = [inv, ...invoices.filter((x) => x.id !== inv.id)].sort((a, b) => b.createdAt - a.createdAt);
    changed();
    return inv;
  }

  /** The last number used (0: none yet). */
  const lastSeq = async () => ((await idb(tx(cdb, 'seq').get(core.mintUrl))) as number | undefined) ?? 0;
  /** Takes the next number: saved before it is used, so it is never handed out twice. */
  async function takeSeq(): Promise<number> {
    const next = (await lastSeq()) + 1;
    await idb(tx(cdb, 'seq', 'readwrite').put(next, core.mintUrl));
    return next;
  }

  const seed = () => {
    const s = localStorage.getItem(core.key('seed'));
    if (!s) throw new Error('This wallet has no seed yet.');
    return s;
  };
  const record = (id: string) => posreq.records().find((r) => r.id === id);
  /** The private key of a request (the one its payments are locked to). */
  const keyOf = (id: string) => {
    const r = record(id);
    if (!r) throw new Error('The payment request for this invoice is missing on this device.');
    return deriveKey(seed(), r.index);
  };
  const info = (): ShopInfo => {
    const p = profile ?? DEFAULT_PROFILE;
    return { name: p.name, address: p.address || undefined, taxId: p.taxId || undefined, contact: p.contact || undefined, footer: p.footer || undefined };
  };
  const log = (inv: Invoice, what: string) => inv.history.push({ at: Date.now(), what });

  /** Closes requests on the payment service; if it can't be reached, a later payment shows as late (refundable). */
  async function closeQuietly(ids: readonly string[]) {
    for (const id of ids) await posreq.cancel(id).catch(() => {});
  }

  /** A new request for `amount`: the invoice number as its description, closing when the invoice expires. */
  async function request(inv: Invoice, amount: number) {
    const rec = await posreq.create(amount, { expiresAt: inv.expiresAt, description: inv.number });
    inv.requests.push(rec.id);
    inv.creq = rec.request;
    return rec;
  }

  return {
    profile: () => profile,
    async setProfile(p: Profile) {
      await idb(tx(db, 'kv', 'readwrite').put(p, 'profile'));
      profile = p;
      changed();
    },
    items: (): readonly Item[] => items,
    async saveItem(it: Omit<Item, 'id'> & { id?: string }) {
      const item = { ...it, id: it.id ?? newId() } as Item;
      await idb(tx(db, 'items', 'readwrite').put(item));
      items = [item, ...items.filter((x) => x.id !== item.id)].sort((a, b) => a.name.localeCompare(b.name));
      changed();
      return item;
    },
    invoices: (): readonly Invoice[] => invoices,
    get: (id: string) => invoices.find((x) => x.id === id),
    rows: (now = Date.now()) => rows(invoices, posreq.records(), now),
    records: (): readonly PosRecord[] => posreq.records(),
    lastSeq,

    /** A draft (not numbered; nothing sent anywhere). */
    async saveDraft(d: Partial<Invoice> & { lines: Line[] }) {
      const p = profile ?? DEFAULT_PROFILE;
      const inv: Invoice = {
        id: d.id ?? newId(),
        kind: d.kind ?? 'sent',
        customer: d.customer,
        lines: d.lines,
        note: d.note,
        taxRate: d.taxRate ?? p.taxRate,
        taxIncluded: d.taxIncluded ?? p.taxIncluded,
        createdAt: d.createdAt ?? Date.now(),
        expiresAt: d.expiresAt,
        requests: [],
        refunds: [],
        history: d.history ?? [{ at: Date.now(), what: 'Created' }],
      };
      return putInvoice(inv);
    },
    async deleteDraft(id: string) {
      const inv = invoices.find((x) => x.id === id);
      if (!inv || inv.issuedAt) throw new Error('Only drafts can be deleted; cancel an issued invoice instead.');
      await idb(tx(db, 'invoices', 'readwrite').delete(id));
      invoices = invoices.filter((x) => x.id !== id);
      changed();
    },

    /**
     * Issues it: the next number (saved first), then a locked payment request for the total.
     * The request's description is only the number; items and customer stay on this device.
     */
    async issue(inv: Invoice): Promise<Invoice> {
      if (inv.issuedAt) return inv;
      const p = profile ?? DEFAULT_PROFILE;
      const { total } = invoiceTotals(inv);
      if (!(total > 0)) throw new Error('The total must be more than zero.');
      // A retry after a failed request keeps the number this invoice already took.
      if (!inv.seq) {
        inv.seq = await takeSeq();
        inv.number = formatNumber(p.prefix, inv.seq);
      }
      const now = Date.now();
      inv.expiresAt ??= now + (inv.kind === 'counter' ? p.counterExpiryMin * 60_000 : p.sentExpiryDays * DAY);
      await putInvoice(inv); // the number is spent even if the request fails
      await request(inv, total);
      inv.issuedAt = now;
      log(inv, `Issued as ${inv.number}`);
      return putInvoice(inv);
    },
    /** "Wait for the rest": a new request for what is still owed; the earlier ones close. */
    async requestRest(inv: Invoice, owed: number) {
      const earlier = [...inv.requests];
      await request(inv, owed);
      await closeQuietly(earlier);
      log(inv, `New payment request for the rest`);
      return putInvoice(inv);
    },
    /** Cancels it here and on the payment service, which then refuses payments to its requests. */
    async cancel(inv: Invoice) {
      inv.cancelledAt = Date.now();
      let told = true;
      for (const id of inv.requests) {
        try {
          await posreq.cancel(id);
        } catch {
          told = false; // offline: cancelled here; a payment that still arrives shows as late, refundable
        }
      }
      log(inv, told ? 'Cancelled' : 'Cancelled on this device (the payment service couldn’t be reached; a payment that still arrives can be refunded)');
      return putInvoice(inv);
    },
    /** Takes what came in as full payment; its requests close, so nothing more is paid to them. */
    async acceptShort(inv: Invoice) {
      inv.acceptedShortAt = Date.now();
      await closeQuietly(inv.requests);
      log(inv, 'Short payment accepted as full');
      return putInvoice(inv);
    },
    /** Same lines and customer, as a new draft. */
    async duplicate(inv: Invoice) {
      return this.saveDraft({ kind: inv.kind, customer: inv.customer, lines: inv.lines.map((l) => ({ ...l })), note: inv.note, taxRate: inv.taxRate, taxIncluded: inv.taxIncluded });
    },
    /**
     * Refunds `amount` as a code to hand back (unlocked, or locked to the payer's key). An extra or
     * partial payment is also marked refunded on its request.
     */
    async refund(inv: Invoice, amount: number, opts: { lockTo?: string; what: string; ref?: string; late?: boolean; extra?: { request: string; n: number } }): Promise<SentToken> {
      const item = await tokens.send(amount, { compact: false, lockTo: opts.lockTo });
      if (opts.extra) posreq.markRefunded(opts.extra.request, opts.extra.n, item.id);
      inv.refunds.push({ at: Date.now(), amount, tokenId: item.id, what: opts.what, ref: opts.ref, late: opts.late });
      log(inv, `Refunded ${amount} zats (${opts.what})`);
      await putInvoice(inv);
      return item;
    },

    /** The customer-facing invoice, as signed for its link. */
    doc(inv: Invoice): InvoiceDoc {
      return {
        v: 1,
        shop: info(),
        number: inv.number!,
        kind: inv.kind,
        customer: inv.customer?.name || undefined,
        lines: inv.lines,
        taxRate: inv.taxRate || undefined,
        taxIncluded: inv.taxIncluded,
        totals: invoiceTotals(inv),
        issuedAt: inv.issuedAt!,
        expiresAt: inv.expiresAt,
        note: inv.note || undefined,
        creq: inv.creq!,
      };
    },
    /** #/invoice/<data>, signed with the newest request's key. */
    async invoiceData(inv: Invoice) {
      return pack('invoice', this.doc(inv), keyOf(inv.requests[inv.requests.length - 1]).priv);
    },
    /** The receipt of a paid invoice and its #/receipt/<data>. */
    async receipt(inv: Invoice): Promise<{ doc: ReceiptDoc; data: string }> {
      const pays = payments(inv, posreq.records());
      const req = inv.requests[0];
      const k = keyOf(req);
      const doc: ReceiptDoc = {
        v: 1,
        shop: info(),
        number: inv.number!,
        lines: inv.lines,
        taxRate: inv.taxRate || undefined,
        taxIncluded: inv.taxIncluded,
        totals: invoiceTotals(inv),
        paid: pays.filter((p) => !p.late).reduce((a, p) => a + p.amount, 0),
        paidAt: paidAt(inv, pays) ?? Date.now(),
        request: req,
        key: k.pub,
      };
      return { doc, data: await pack('receipt', doc, k.priv) };
    },

    async dump(): Promise<ShopDump> {
      return { format: 'zec-ecash-shop', version: 1, mintUrl: core.mintUrl, profile, items, invoices, seq: await lastSeq() };
    },
    /** Restores a dump into this device's shop (replacing it); the counter only ever moves up. */
    async restore(d: ShopDump) {
      if (d?.format !== 'zec-ecash-shop' || d.version !== 1) throw new Error('That file is not zec-ecash shop data.');
      if (d.mintUrl !== core.mintUrl) throw new Error(`That shop data is for ${d.mintUrl}; this wallet uses ${core.mintUrl}.`);
      await this.wipe();
      if (d.profile) await this.setProfile(d.profile);
      for (const it of d.items ?? []) await idb(tx(db, 'items', 'readwrite').put(it));
      for (const inv of d.invoices ?? []) await idb(tx(db, 'invoices', 'readwrite').put(inv));
      items = [...(d.items ?? [])];
      invoices = [...(d.invoices ?? [])].sort((a, b) => b.createdAt - a.createdAt);
      if ((d.seq ?? 0) > (await lastSeq())) await idb(tx(cdb, 'seq', 'readwrite').put(d.seq, core.mintUrl));
      changed();
    },
    /** Deletes the profile, catalogue and invoices (not the counter). */
    async wipe() {
      for (const s of ['kv', 'items', 'invoices']) await idb(tx(db, s, 'readwrite').clear());
      profile = null;
      items = [];
      invoices = [];
      changed();
    },
    on(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Shop = Awaited<ReturnType<typeof openShop>>;

// ---- the customer's side: invoices paid and receipts saved in this wallet ----

/** A shop document this wallet paid or saved, for its Activity. */
export type Purchase = { id: string; at: number; kind: 'invoice' | 'receipt'; number: string; shop: string; total: number; data: string; tokenId?: string };

export function purchases(core: Core): Purchase[] {
  try {
    return JSON.parse(localStorage.getItem(core.key('purchases')) ?? '[]') as Purchase[];
  } catch {
    return [];
  }
}

export function savePurchase(core: Core, p: Omit<Purchase, 'id' | 'at'>) {
  const all = purchases(core).filter((x) => !(x.kind === p.kind && x.data === p.data));
  localStorage.setItem(core.key('purchases'), JSON.stringify([{ ...p, id: newId(), at: Date.now() }, ...all].slice(0, 500)));
  core.emit({ type: 'activity' });
}
