// Invoices: the list (search, filters, sort, CSV), the editor (a draft until Issue), and an
// invoice's page: state, items, history, sharing (link, QR, PDF), the receipt, and the
// actions (wait for the rest, accept as is, refund, cancel, duplicate).
import { busy, copyText, h, svg, ICON } from '../../ui/dom';
import { qrCard } from '../../ui/qr';
import { go } from '../../ui/router';
import { details, field, kv, moneyEl, pageHead, waiting, type App, type Page } from '../../ui/widgets';
import { moneyText, parseAmount } from '../../ui/words';
import { DAY, STATE_LABEL, invoiceTotals, invoicesCsv, linesCsv, matches, totals, type Invoice, type Line, type Payment, type Row, type State } from '../model';
import type { Shop } from '../store';
import { badge, deliver, linkFor, linesTable, pdfKit, totalsBlock, when } from './common';

export const invoicesPage = (shop: Shop): Page => ({
  title: 'Invoices',
  render(app, route) {
    const id = route.params.get('id');
    const edit = route.params.get('edit');
    if (route.params.has('new') || edit) return editor(app, shop, edit ? shop.get(edit) : undefined);
    const inv = id ? shop.get(id) : undefined;
    return inv ? detail(app, shop, inv) : list(app, shop);
  },
});

// ---------------- the list ----------------

const SORTS: Record<string, [string, (a: Row, b: Row) => number]> = {
  new: ['Newest first', (a, b) => (b.inv.issuedAt ?? b.inv.createdAt) - (a.inv.issuedAt ?? a.inv.createdAt)],
  old: ['Oldest first', (a, b) => (a.inv.issuedAt ?? a.inv.createdAt) - (b.inv.issuedAt ?? b.inv.createdAt)],
  big: ['Largest total', (a, b) => b.total - a.total],
  num: ['Number', (a, b) => (b.inv.seq ?? 0) - (a.inv.seq ?? 0)],
};

const dateValue = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const dateFrom = (v: string) => (v ? new Date(`${v}T00:00`).getTime() : undefined);

function list(app: App, shop: Shop) {
  const q = h('input', { type: 'search', class: 'input', placeholder: 'Number, customer, note or item', 'aria-label': 'Search invoices' });
  const state = h('select', { class: 'input', 'aria-label': 'State' }, h('option', { value: '' }, 'Any state'), (Object.keys(STATE_LABEL) as State[]).map((s) => h('option', { value: s }, STATE_LABEL[s])));
  const kind = h('select', { class: 'input', 'aria-label': 'Kind' }, h('option', { value: '' }, 'Counter and sent'), h('option', { value: 'counter' }, 'Counter sales'), h('option', { value: 'sent' }, 'Sent invoices'));
  const from = h('input', { type: 'date', class: 'input', 'aria-label': 'From date' });
  const to = h('input', { type: 'date', class: 'input', 'aria-label': 'To date' });
  const sort = h('select', { class: 'input', 'aria-label': 'Sort' }, Object.entries(SORTS).map(([k, [label]]) => h('option', { value: k }, label)));
  const body = h('div');
  const count = h('p', { class: 'hint' });

  const filtered = () => {
    const f = dateFrom(from.value);
    const t = dateFrom(to.value);
    return shop
      .rows()
      .filter((r) => matches(r.inv, q.value))
      .filter((r) => !state.value || r.state === state.value)
      .filter((r) => !kind.value || r.inv.kind === kind.value)
      .filter((r) => {
        const at = r.inv.issuedAt ?? r.inv.createdAt;
        return (f === undefined || at >= f) && (t === undefined || at < t + DAY);
      })
      .sort(SORTS[sort.value][1]);
  };
  const draw = () => {
    const rs = filtered();
    count.textContent = `${rs.length} ${rs.length === 1 ? 'invoice' : 'invoices'}`;
    body.replaceChildren(
      rs.length
        ? h(
            'table',
            { class: 'inv-table' },
            h('thead', null, h('tr', null, h('th', null, 'Number'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Total'), h('th', null, 'State'), h('th', null, 'Date'))),
            h(
              'tbody',
              null,
              rs.map((r) =>
                h(
                  'tr',
                  { class: 'inv-row', 'data-id': r.inv.id, onclick: () => go(`/invoices?id=${encodeURIComponent(r.inv.id)}`) },
                  h('td', { 'data-label': 'Number' }, h('a', { href: `#/invoices?id=${encodeURIComponent(r.inv.id)}`, class: 'mono' }, r.inv.number ?? 'Draft')),
                  h('td', { 'data-label': 'Customer' }, r.inv.customer?.name ?? (r.inv.kind === 'counter' ? 'Counter sale' : '—')),
                  h('td', { class: 'num mono', 'data-label': 'Total' }, moneyText(r.total)),
                  h('td', { 'data-label': 'State' }, badge(r.state)),
                  h('td', { 'data-label': 'Date' }, when(r.inv.issuedAt ?? r.inv.createdAt)),
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, h('p', null, shop.invoices().length ? 'No invoices match.' : 'No invoices yet.')),
    );
  };
  for (const c of [q, state, kind, from, to, sort]) c.addEventListener('input', draw);
  draw();
  const csv = (which: 'invoices' | 'lines') => () => {
    const rs = filtered();
    void deliver(which === 'invoices' ? invoicesCsv(rs) : linesCsv(rs), `${which === 'invoices' ? 'invoices' : 'invoice-lines'}-${dateValue(Date.now())}.csv`, 'text/csv');
  };
  const el = h(
    'div',
    { class: 'page wide' },
    pageHead('Invoices', { right: h('a', { href: '#/invoices?new=1', class: 'btn primary' }, svg(ICON.plus), 'New invoice') }),
    h('div', { class: 'filters' }, q, state, kind, h('label', { class: 'range' }, h('span', null, 'From'), from), h('label', { class: 'range' }, h('span', null, 'To'), to), sort),
    h('div', { class: 'row wrap between' }, count, h('div', { class: 'row wrap' }, h('button', { type: 'button', class: 'btn', onclick: csv('invoices') }, 'Export CSV'), h('button', { type: 'button', class: 'btn', onclick: csv('lines') }, 'Line items CSV'))),
    body,
  );
  const off = [shop.on(draw), app.onChange(draw)];
  const timer = setInterval(draw, 30_000); // expiries
  return { el, cleanup: () => (off.forEach((f) => f()), clearInterval(timer)) };
}

// ---------------- the editor ----------------

/** Rows of description, quantity and unit price; a catalogue picker; live totals. */
export function linesEditor(shop: Shop, lines: Line[], onChange: () => void) {
  const box = h('div', { class: 'line-edit' });
  const draw = () => {
    box.replaceChildren(
      ...lines.map((l, i) => {
        const desc = h('input', { type: 'text', class: 'input', value: l.desc, 'aria-label': `Item ${i + 1} description`, placeholder: 'Description' });
        const qty = h('input', { type: 'text', inputmode: 'numeric', class: 'input mono', value: String(l.qty), 'aria-label': `Item ${i + 1} quantity` });
        const unit = h('input', { type: 'text', inputmode: 'numeric', class: 'input mono', value: l.unit ? String(l.unit) : '', 'aria-label': `Item ${i + 1} unit price in zats`, placeholder: 'zats' });
        desc.oninput = () => ((l.desc = desc.value), onChange());
        qty.oninput = () => ((l.qty = Math.max(0, Math.floor(Number(qty.value.replace(/\D/g, '')) || 0))), onChange());
        unit.oninput = () => ((l.unit = Math.max(0, Math.floor(Number(unit.value.replace(/\D/g, '')) || 0))), onChange());
        const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove item ${i + 1}` }, svg(ICON.close));
        del.onclick = () => {
          lines.splice(i, 1);
          draw();
          onChange();
        };
        return h('div', { class: 'line-row' }, desc, qty, unit, del);
      }),
    );
  };
  const items = shop.items().filter((i) => !i.archived);
  const pick = h('select', { class: 'input', 'aria-label': 'Add an item from the catalogue' }, h('option', { value: '' }, items.length ? 'Add from catalogue…' : 'No catalogue items'), items.map((i) => h('option', { value: i.id }, `${i.name} · ${moneyText(i.price)}`)));
  pick.onchange = () => {
    const it = items.find((i) => i.id === pick.value);
    pick.value = '';
    if (!it) return;
    const same = lines.find((l) => l.itemId === it.id);
    if (same) same.qty += 1;
    else lines.push({ desc: it.name, qty: 1, unit: it.price, itemId: it.id });
    draw();
    onChange();
  };
  const add = h('button', { type: 'button', class: 'btn' }, svg(ICON.plus), 'Add a line');
  add.onclick = () => {
    lines.push({ desc: '', qty: 1, unit: 0 });
    draw();
    (box.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
    onChange();
  };
  draw();
  return h('div', { class: 'stack' }, h('div', { class: 'line-head', 'aria-hidden': 'true' }, h('span', null, 'Description'), h('span', null, 'Qty'), h('span', null, 'Unit price (zats)'), h('span', null, '')), box, h('div', { class: 'row wrap' }, pick, add));
}

function editor(app: App, shop: Shop, existing?: Invoice) {
  if (existing?.issuedAt) {
    go(`/invoices?id=${encodeURIComponent(existing.id)}`, true);
    return { el: h('div') };
  }
  const p = shop.profile();
  const lines: Line[] = existing ? existing.lines.map((l) => ({ ...l })) : [{ desc: '', qty: 1, unit: 0 }];
  const name = h('input', { type: 'text', class: 'input', value: existing?.customer?.name ?? '', autocomplete: 'off' });
  const email = h('input', { type: 'email', class: 'input', value: existing?.customer?.email ?? '', autocomplete: 'off' });
  const note = h('textarea', { class: 'input', rows: '2', value: existing?.note ?? '' });
  const tax = h('input', { type: 'text', inputmode: 'decimal', class: 'input mono', value: String(existing?.taxRate ?? p?.taxRate ?? '') });
  const incl = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: existing?.taxIncluded ?? p?.taxIncluded ?? true });
  const due = h('input', { type: 'date', class: 'input', value: dateValue(existing?.expiresAt ?? Date.now() + (p?.sentExpiryDays ?? 7) * DAY) });
  const sums = h('div');
  const err = h('p', { class: 'field-err', role: 'alert' });
  const rate = () => {
    const r = Number(tax.value.replace(',', '.'));
    return Number.isFinite(r) && r > 0 ? r : undefined;
  };
  const update = () => sums.replaceChildren(totalsBlock(totals(lines.filter((l) => l.qty > 0), rate(), incl.checked), rate(), incl.checked));
  tax.oninput = update;
  incl.onchange = update;
  update();
  const collect = () => {
    const ls = lines.filter((l) => l.qty > 0 && (l.desc.trim() || l.unit));
    if (!ls.length || totals(ls).total <= 0) throw new Error('Add at least one item with a price.');
    if (ls.some((l) => !l.desc.trim())) throw new Error('Every item needs a description.');
    const end = dateFrom(due.value);
    if (end !== undefined && end + DAY <= Date.now()) throw new Error('The due date has passed.');
    return {
      id: existing?.id,
      createdAt: existing?.createdAt,
      history: existing?.history,
      kind: 'sent' as const,
      customer: name.value.trim() || email.value.trim() ? { name: name.value.trim() || undefined, email: email.value.trim() || undefined } : undefined,
      lines: ls.map((l) => ({ ...l, desc: l.desc.trim() })),
      note: note.value.trim() || undefined,
      taxRate: rate(),
      taxIncluded: incl.checked,
      expiresAt: end === undefined ? undefined : end + DAY - 1, // the end of the due day
    };
  };
  const save = h('button', { type: 'button', class: 'btn' }, 'Save draft');
  const issue = h('button', { type: 'button', class: 'btn primary' }, 'Issue');
  save.onclick = () =>
    void busy(save, async () => {
      err.textContent = '';
      const d = await shop.saveDraft(collect());
      go(`/invoices?id=${encodeURIComponent(d.id)}`, true);
    }, (e) => (err.textContent = app.explain(e)));
  issue.onclick = () =>
    void busy(issue, async () => {
      err.textContent = '';
      const d = await shop.saveDraft(collect());
      await shop.issue(d);
      go(`/invoices?id=${encodeURIComponent(d.id)}`, true);
    }, (e) => (err.textContent = app.explain(e)));
  const el = h(
    'div',
    { class: 'page wide' },
    pageHead(existing ? 'Edit draft' : 'New invoice', { back: true }),
    h(
      'div',
      { class: 'edit-grid' },
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'tag' }, '[ Customer ]'),
        field('Name (optional)', name),
        field('Email (optional)', email, 'Kept on this device; never in the link or sent to the payment service.'),
        h('h2', { class: 'tag' }, '[ Items ]'),
        linesEditor(shop, lines, update),
        field('Note (optional)', note),
      ),
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'tag' }, '[ Totals ]'),
        field('Tax rate % (optional)', tax),
        h('label', { class: 'toggle' }, incl, h('span', null, h('strong', null, 'Prices include tax'))),
        field('Pay by', due),
        sums,
        err,
        h('div', { class: 'row wrap' }, save, issue),
        h('p', { class: 'hint' }, 'Issue gives it the next number and a payment code. Only the number goes to the payment service.'),
      ),
    ),
  );
  return { el };
}

// ---------------- an invoice ----------------

/** What a payment was, in words. */
const payLabel = (p: Payment) => (p.late ? 'Late payment' : p.kind === 'partial' ? 'Partial payment' : p.kind === 'extra' ? 'Extra payment' : 'Payment');

/** Make a refund code (unlocked, or locked to the payer's key), then show it. */
export function refundBox(app: App, shop: Shop, inv: Invoice, amount: number, what: string, opts: { ref?: string; late?: boolean; extra?: { request: string; n: number } } = {}) {
  const pub = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', placeholder: 'optional: 02… or 03…' });
  const amt = h('input', { type: 'text', inputmode: 'numeric', class: 'input mono', value: String(amount) });
  const make = h('button', { type: 'button', class: 'btn danger block' }, 'Make the refund code');
  const box = h(
    'div',
    { class: 'stack refund-box', hidden: true },
    opts.extra || opts.late ? null : field('Amount to refund (zats)', amt),
    field('Their receive code (optional)', pub, 'With it, only they can take the refund. Without it, anyone holding the refund code can.'),
    make,
  );
  const open = h('button', { type: 'button', class: 'btn danger-outline' }, 'Refund');
  open.onclick = () => (box.hidden = !box.hidden);
  make.onclick = () =>
    void busy(
      make,
      async () => {
        const n = opts.extra || opts.late ? amount : parseAmount(amt.value, 'zats');
        if (!n || n > amount) throw new Error(`Refund at most ${moneyText(amount)}.`);
        const item = await shop.refund(inv, n, { lockTo: pub.value.trim() || undefined, what, ref: opts.ref, late: opts.late, extra: opts.extra });
        go(`/send?t=${encodeURIComponent(item.id)}`);
      },
      app.explain,
    );
  return h('div', { class: 'stack' }, open, box);
}

function detail(app: App, shop: Shop, inv0: Invoice) {
  const body = h('div', { class: 'inv-detail' });
  let last = '';
  const draw = (force = false) => {
    const inv = shop.get(inv0.id) ?? inv0;
    const row = shop.rows().find((r) => r.inv.id === inv.id)!;
    const key = JSON.stringify([row.state, row.paid, row.refunded, row.late, inv.requests.length, row.pays.map((p) => [p.amount, p.collected, p.refundId])]);
    if (key === last && !force) return;
    last = key;
    body.replaceChildren(...view(app, shop, inv, row, () => draw(true)));
  };
  draw();
  const tick = () => {
    const inv = shop.get(inv0.id);
    if (inv?.issuedAt) void app.posreq.collectAll((r) => inv.requests.includes(r.id), 5000);
  };
  tick();
  const timers = [setInterval(tick, 3000), setInterval(() => draw(), 15_000)];
  const off = [shop.on(() => draw()), app.onChange(() => draw())];
  const el = h('div', { class: 'page wide' }, pageHead(inv0.number ?? 'Draft', { back: true, right: h('span', { class: 'head-badge' }) }), body);
  // the title row follows the invoice: its number once issued, and its state
  const syncBadge = () => {
    const r = shop.rows().find((x) => x.inv.id === inv0.id);
    if (!r) return;
    el.querySelector('.head-badge')!.replaceChildren(badge(r.state));
    el.querySelector('.page-title')!.textContent = r.inv.number ?? 'Draft';
  };
  syncBadge();
  const off2 = shop.on(syncBadge);
  const off3 = app.onChange(syncBadge);
  return { el, cleanup: () => (timers.forEach(clearInterval), off.forEach((f) => f()), off2(), off3()) };
}

function view(app: App, shop: Shop, inv: Invoice, row: Row, redraw: () => void): Node[] {
  const t = invoiceTotals(inv);
  const p = shop.profile();
  const out: Node[] = [];
  const actions = h('div', { class: 'row wrap actions-row no-print' });

  // ---- summary ----
  out.push(
    h(
      'section',
      { class: 'card inv-sum' },
      h('div', { class: 'sum-top' }, moneyEl(t.total, { cls: 'code-money' }), badge(row.state)),
      h(
        'div',
        { class: 'sum-facts' },
        kv('Kind', inv.kind === 'counter' ? 'Counter sale' : 'Sent invoice'),
        inv.customer?.name ? kv('Customer', inv.customer.name) : null,
        inv.customer?.email ? kv('Email', inv.customer.email) : null,
        inv.issuedAt ? kv('Issued', when(inv.issuedAt)) : kv('Created', when(inv.createdAt)),
        inv.expiresAt ? kv(inv.kind === 'sent' ? 'Pay by' : 'Expires', when(inv.expiresAt)) : null,
        inv.issuedAt ? kv('Paid', `${moneyText(row.paid)} of ${moneyText(t.total)}`) : null,
        row.refunded ? kv('Refunded', moneyText(row.refunded)) : null,
        row.late ? kv('Late payments', moneyText(row.late)) : null,
      ),
    ),
  );
  out.push(h('section', { class: 'card' }, linesTable(inv.lines), totalsBlock(t, inv.taxRate, inv.taxIncluded), inv.note ? h('p', { class: 'hint' }, inv.note) : null));

  // ---- actions ----
  if (!inv.issuedAt) {
    const issue = h('button', { type: 'button', class: 'btn primary' }, 'Issue');
    issue.onclick = () => void busy(issue, async () => void (await shop.issue(inv)), app.explain);
    const del = h('button', { type: 'button', class: 'btn danger-outline' }, 'Delete draft');
    del.onclick = () => void busy(del, async () => (await shop.deleteDraft(inv.id), go('/invoices', true)), app.explain);
    actions.append(issue, h('a', { href: `#/invoices?edit=${encodeURIComponent(inv.id)}`, class: 'btn' }, 'Edit'), del);
    out.push(actions);
  } else {
    const share = h('div', { class: 'stack share-box', hidden: true });
    const shareBtn = h('button', { type: 'button', class: 'btn primary' }, svg(ICON.share), 'Share');
    shareBtn.onclick = () =>
      void busy(shareBtn, async () => {
        if (!share.hidden) return void (share.hidden = true);
        const link = linkFor('invoice', await shop.invoiceData(inv));
        share.replaceChildren(
          qrCard(link, { label: `QR code of the link to ${inv.number}`, ecc: 'L', caption: 'Link to this invoice' }),
          h('div', { class: 'row wrap' }, h('button', { type: 'button', class: 'btn', onclick: () => void copyText(link, 'Link') }, svg(ICON.copy), 'Copy link'), 'share' in navigator ? h('button', { type: 'button', class: 'btn', onclick: () => void navigator.share({ title: `Invoice ${inv.number}`, url: link }).catch(() => {}) }, 'Share…') : null),
          h('p', { class: 'hint' }, `${link.length} characters. The link carries the invoice and its payment code, signed; your logo isn’t in it.`),
          h('input', { type: 'text', class: 'input mono link-text', readonly: true, value: link, 'aria-label': 'Invoice link' }),
        );
        share.hidden = false;
      }, app.explain);
    const pdf = h('button', { type: 'button', class: 'btn' }, 'PDF');
    pdf.onclick = () =>
      void busy(pdf, async () => {
        const [{ invoicePdf }, data] = await Promise.all([pdfKit(), shop.invoiceData(inv)]);
        const bytes = await invoicePdf(shop.doc(inv), { logo: p?.logo, state: row.state, link: linkFor('invoice', data), email: inv.customer?.email });
        await deliver(bytes, `${inv.number}.pdf`, 'application/pdf');
      }, app.explain);
    const dup = h('button', { type: 'button', class: 'btn' }, 'Duplicate');
    dup.onclick = () => void busy(dup, async () => go(`/invoices?id=${encodeURIComponent((await shop.duplicate(inv)).id)}`), app.explain);
    actions.append(shareBtn, pdf, dup);
    if (row.state === 'open' || row.state === 'partial') {
      const cancel = h('button', { type: 'button', class: 'btn danger-outline' }, 'Cancel invoice');
      cancel.onclick = () => {
        const yes = h('button', { type: 'button', class: 'btn danger' }, 'Yes, cancel it');
        yes.onclick = () => void busy(yes, async () => void (await shop.cancel(inv)), app.explain);
        cancel.replaceWith(h('div', { class: 'ask' }, h('p', null, 'Cancel this invoice? Payments that still arrive can be refunded.'), h('div', { class: 'row' }, yes, h('button', { type: 'button', class: 'btn ghost', onclick: redraw }, 'Keep it'))));
      };
      actions.append(cancel);
    }
    out.push(actions, share);
  }

  // ---- waiting / partial ----
  if (inv.issuedAt && (row.state === 'open' || row.state === 'partial')) {
    const box = h('section', { class: 'card stack' });
    if (row.state === 'partial') {
      const rest = h('button', { type: 'button', class: 'btn primary' }, `Ask for the rest (${moneyText(row.owed)})`);
      rest.onclick = () => void busy(rest, async () => void (await shop.requestRest(inv, row.owed)), app.explain);
      const accept = h('button', { type: 'button', class: 'btn' }, 'Accept as is');
      accept.onclick = () => void busy(accept, async () => void (await shop.acceptShort(inv)), app.explain);
      box.append(h('p', { class: 'partial-line mono' }, `Received ${moneyText(row.paid)} of ${moneyText(t.total)}`), h('div', { class: 'row wrap' }, rest, accept));
    }
    if (inv.creq) box.append(h('div', { class: 'status-line' }, waiting('Waiting for payment…')), qrCard(inv.creq, { label: `Payment code for ${inv.number}`, ecc: 'M', caption: 'Payment code' }));
    out.push(box);
  }

  // ---- receipt ----
  if (row.state === 'paid' || row.state === 'overpaid' || row.state === 'part-refunded') out.push(receiptBox(app, shop, inv));

  // ---- payments, refunds, history ----
  const pays = row.pays;
  if (pays.length || inv.refunds.length) {
    const sec = h('section', { class: 'card stack' }, h('h2', { class: 'tag' }, '[ Payments ]'));
    for (const pay of pays) {
      const ref = `${pay.request}:${pay.n ?? 'main'}`;
      const refunded = !!pay.refundId || inv.refunds.some((r) => r.ref === ref);
      const line = h('div', { class: `pay-row ${pay.late ? 'late' : ''}` }, h('div', null, h('strong', null, `${payLabel(pay)} · ${moneyText(pay.amount)}`), h('span', { class: 'hint' }, ` ${when(pay.at)}${pay.collected ? '' : ' · receiving…'}${refunded ? ' · refunded' : ''}`)));
      // extras, partials and late payments can be refunded one by one (as on Receive)
      if (!refunded && pay.collected && (pay.kind !== 'payment' || pay.late)) {
        line.append(refundBox(app, shop, inv, pay.amount, payLabel(pay).toLowerCase(), { ref, late: pay.late, extra: pay.kind !== 'payment' && pay.n !== undefined ? { request: pay.request, n: pay.n } : undefined }));
      }
      sec.append(line);
    }
    for (const r of inv.refunds) sec.append(h('div', { class: 'pay-row refund' }, h('div', null, h('strong', null, `Refund · ${moneyText(r.amount)}`), h('span', { class: 'hint' }, ` ${when(r.at)} · `, h('a', { href: `#/send?t=${encodeURIComponent(r.tokenId)}` }, 'the refund code')))));
    // a full or part refund of what was paid
    const left = row.paid - row.refunded;
    if (left > 0 && ['paid', 'overpaid', 'part-refunded'].includes(row.state)) sec.append(h('div', { class: 'pay-row' }, h('div', null, h('strong', null, 'Refund the sale'), h('span', { class: 'hint' }, ` up to ${moneyText(left)}`)), refundBox(app, shop, inv, left, 'sale')));
    out.push(sec);
  }
  out.push(
    details(
      ...[...inv.history.map((x) => ({ at: x.at, what: x.what })), ...pays.map((x) => ({ at: x.at, what: `${payLabel(x)} of ${x.amount} zats (request ${x.request.slice(0, 8)}…)` }))]
        .sort((a, b) => a.at - b.at)
        .map((x) => kv(when(x.at), x.what)),
      h('p', { class: 'hint' }, `Paid through ${inv.requests.length} NUT-18 payment request${inv.requests.length === 1 ? '' : 's'}, each locked (P2PK) to a fresh key from this wallet’s seed; the request’s description is only the invoice number.`),
    ),
  );
  return out;
}

/** The receipt: a signed QR code and link, and PDFs (A4, 80 mm). */
export function receiptBox(app: App, shop: Shop, inv: Invoice) {
  const box = h('section', { class: 'card stack receipt-box' }, h('h2', { class: 'tag' }, '[ Receipt ]'), h('div', { class: 'working' }, waiting('Signing…')));
  void shop.receipt(inv).then(
    ({ doc, data }) => {
      const link = linkFor('receipt', data);
      const pdf = (width: 'a4' | '80mm') => {
        const b = h('button', { type: 'button', class: 'btn' }, width === 'a4' ? 'Receipt PDF' : 'Receipt PDF (80 mm)');
        b.onclick = () =>
          void busy(b, async () => {
            const { receiptPdf } = await pdfKit();
            await deliver(await receiptPdf(doc, { logo: shop.profile()?.logo, link, width }), `${inv.number}-receipt${width === '80mm' ? '-80mm' : ''}.pdf`, 'application/pdf');
          }, app.explain);
        return b;
      };
      box.replaceChildren(
        h('h2', { class: 'tag' }, '[ Receipt ]'),
        qrCard(link, { label: `Receipt QR code for ${inv.number}`, ecc: 'L' }),
        h('p', { class: 'hint center' }, 'Their wallet can scan this to keep the receipt.'),
        h('div', { class: 'row wrap no-print' }, h('button', { type: 'button', class: 'btn', onclick: () => void copyText(link, 'Receipt link') }, svg(ICON.copy), 'Copy link'), pdf('a4'), pdf('80mm')),
      );
    },
    (e) => box.replaceChildren(h('p', { class: 'field-err' }, app.explain(e))),
  );
  return box;
}

