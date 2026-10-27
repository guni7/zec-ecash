// Charge: the counter terminal. Build a sale from catalogue items and/or a keypad amount, then
// Charge shows the customer screen: full screen, the shop, the total, the payment code and a
// countdown, with the screen kept on. Paid: a big ✓ with a chime, the receipt code, New sale,
// and back by itself after a few seconds. Short payments: wait for the rest, accept, or refund.
import { busy, h, svg, ICON } from '../../ui/dom';
import { qrCard } from '../../ui/qr';
import { go } from '../../ui/router';
import { moneyEl, pageHead, waiting, type App, type Page } from '../../ui/widgets';
import { moneyText } from '../../ui/words';
import { invoiceTotals, totals, type Invoice, type Line } from '../model';
import type { Shop } from '../store';
import { countdownTo, keepAwake, linkFor, paidChime, totalsBlock, unlockSound } from './common';
import { refundBox } from './invoices';

/** The sale being built survives leaving the page (not a reload). */
let cart: Line[] = [];

export const chargePage = (shop: Shop): Page => ({
  title: 'Charge',
  render(app, route) {
    const id = route.params.get('inv');
    const inv = id ? shop.get(id) : undefined;
    return inv ? customer(app, shop, inv) : terminal(app, shop);
  },
});

function terminal(app: App, shop: Shop) {
  const p = shop.profile();
  const cartBox = h('div', { class: 'cart-lines' });
  const sums = h('div');
  const err = h('p', { class: 'field-err', role: 'alert' });
  const charge = h('button', { type: 'button', class: 'btn primary block big charge-btn' }, 'Charge');
  const barTotal = h('span', { class: 'mono' });
  const bar = h('div', { class: 'charge-bar', hidden: true }, barTotal, h('button', { type: 'button', class: 'btn primary', onclick: () => charge.click() }, 'Charge'));

  const update = () => {
    cart = cart.filter((l) => l.qty > 0);
    cartBox.replaceChildren(
      ...(cart.length
        ? cart.map((l) => {
            const minus = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `One less ${l.desc}` }, '−');
            const plus = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `One more ${l.desc}` }, '+');
            minus.onclick = () => ((l.qty -= 1), update());
            plus.onclick = () => ((l.qty += 1), update());
            return h('div', { class: 'cart-line' }, h('span', { class: 'cart-desc' }, l.desc), h('span', { class: 'qty' }, minus, h('span', { class: 'mono' }, String(l.qty)), plus), h('span', { class: 'mono num' }, moneyText(Math.round(l.qty * l.unit))));
          })
        : [h('p', { class: 'hint' }, 'Tap items or type an amount.')]),
    );
    const t = totals(cart, p?.taxRate, p?.taxIncluded ?? true);
    sums.replaceChildren(totalsBlock(t, p?.taxRate, p?.taxIncluded ?? true));
    charge.textContent = t.total ? `Charge ${moneyText(t.total)}` : 'Charge';
    charge.disabled = !t.total;
    barTotal.textContent = `${cart.reduce((a, l) => a + l.qty, 0)} items · ${moneyText(t.total)}`;
    bar.hidden = !t.total;
  };

  // the catalogue
  const items = shop.items().filter((i) => !i.archived);
  const cats = [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))];
  let cat = '';
  const grid = h('div', { class: 'item-grid' });
  const drawGrid = () =>
    grid.replaceChildren(
      ...items
        .filter((i) => !cat || i.category === cat)
        .map((i) => {
          const b = h('button', { type: 'button', class: 'item-btn' }, h('span', { class: 'item-name' }, i.name), h('span', { class: 'mono item-price' }, moneyText(i.price)));
          b.onclick = () => {
            const l = cart.find((x) => x.itemId === i.id);
            if (l) l.qty += 1;
            else cart.push({ desc: i.name, qty: 1, unit: i.price, itemId: i.id });
            update();
          };
          return b;
        }),
    );
  const chips = cats.length
    ? h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Category' },
        ['', ...cats].map((c) => {
          const b = h('button', { type: 'button', class: `chip-btn ${c === cat ? 'on' : ''}`, 'aria-pressed': String(c === cat) }, c || 'All');
          b.onclick = () => {
            cat = c;
            chips!.querySelectorAll('button').forEach((x) => (x.classList.toggle('on', x === b), x.setAttribute('aria-pressed', String(x === b))));
            drawGrid();
          };
          return b;
        }),
      )
    : null;
  drawGrid();

  // the keypad: a custom amount (zats) with an optional note
  let typed = '';
  const display = h('output', { class: 'keypad-display mono', 'aria-live': 'polite' }, '0');
  const note = h('input', { type: 'text', class: 'input', placeholder: 'Note (optional)', 'aria-label': 'Note for this amount' });
  const showTyped = () => (display.textContent = typed ? `${Number(typed).toLocaleString('en-US')} zats` : '0');
  const key = (k: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'key',
        'aria-label': k === '⌫' ? 'Delete a digit' : k,
        onclick: () => {
          if (k === '⌫') typed = typed.slice(0, -1);
          else if (typed.length < 12) typed = (typed + k).replace(/^0+/, '');
          showTyped();
        },
      },
      k,
    );
  const addAmount = h('button', { type: 'button', class: 'btn block' }, svg(ICON.plus), 'Add amount');
  addAmount.onclick = () => {
    const n = Number(typed);
    if (!n) return;
    cart.push({ desc: note.value.trim() || 'Amount', qty: 1, unit: n });
    typed = '';
    note.value = '';
    showTyped();
    update();
  };
  const keypad = h('div', { class: 'keypad' }, display, h('div', { class: 'keys' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map(key)), note, addAmount);

  charge.onclick = () => {
    unlockSound();
    void busy(
      charge,
      async () => {
        err.textContent = '';
        const draft = await shop.saveDraft({ kind: 'counter', lines: cart.map((l) => ({ ...l })) });
        const inv = await shop.issue(draft);
        cart = [];
        go(`/charge?inv=${encodeURIComponent(inv.id)}`);
      },
      (e) => (err.textContent = app.explain(e)),
    );
  };
  const clear = h('button', { type: 'button', class: 'btn ghost' }, 'Clear');
  clear.onclick = () => ((cart = []), update());
  update();

  const el = h(
    'div',
    { class: 'page wide charge' },
    pageHead('Charge'),
    h(
      'div',
      { class: 'charge-grid' },
      h('section', { class: 'card stack' }, items.length ? h('div', { class: 'stack' }, chips, grid) : h('p', { class: 'hint' }, 'No catalogue yet: ', h('a', { href: '#/shop' }, 'add items'), ', or use the keypad.'), keypad),
      h('section', { class: 'card stack cart' }, h('h2', { class: 'tag' }, '[ Sale ]'), cartBox, sums, err, charge, clear),
    ),
    // phones: the total and Charge stay in reach above the tab bar
    bar,
  );
  return { el };
}

/** The screen the customer sees. */
function customer(app: App, shop: Shop, inv0: Invoice) {
  const p = shop.profile();
  const stage = h('div', { class: 'cust-stage' });
  const timer = h('span', { class: 'mono' });
  let release: (() => void) | undefined;
  void keepAwake().then((r) => (release = r));
  let shown = '';
  let back: ReturnType<typeof setTimeout> | undefined;
  let ticking: ReturnType<typeof setInterval> | undefined;

  const head = h(
    'div',
    { class: 'cust-head' },
    p?.logo ? h('img', { src: p.logo, alt: '', class: 'cust-logo' }) : null,
    h('span', { class: 'cust-shop' }, p?.name ?? ''),
  );

  const newSale = () => go('/charge', true);

  const draw = () => {
    const inv = shop.get(inv0.id) ?? inv0;
    const row = shop.rows().find((r) => r.inv.id === inv.id)!;
    const t = invoiceTotals(inv);
    const key = `${row.state}:${row.paid}:${inv.creq}`;
    if (key === shown) return;
    const was = shown;
    shown = key;
    if (row.state === 'paid' || row.state === 'overpaid') {
      if (!was.startsWith('paid') && !was.startsWith('overpaid')) paidChime();
      const left = h('span', null);
      const actions = h('div', { class: 'cust-actions' }, h('button', { type: 'button', class: 'btn primary big', onclick: newSale }, 'New sale'));
      stage.replaceChildren(
        h('div', { class: 'cust-paid', role: 'status' }, svg(ICON.check), h('h2', null, 'Paid ✓'), moneyEl(row.paid, { cls: 'result-money' })),
        row.state === 'overpaid' ? h('p', { class: 'warn-line' }, `${moneyText(row.paid - t.total)} more than the total came in. Refund it from the invoice.`) : '',
        h('div', { class: 'cust-receipt' }, h('div', { class: 'working' }, waiting('Receipt…'))),
        actions,
        p?.autoReturnSec ? h('p', { class: 'hint center' }, left) : '',
      );
      void shop.receipt(inv).then(
        ({ data }) => stage.querySelector('.cust-receipt')?.replaceChildren(qrCard(linkFor('receipt', data), { label: `Receipt for ${inv.number}`, ecc: 'L' }), h('p', { class: 'hint center' }, 'Scan to keep the receipt')),
        () => stage.querySelector('.cust-receipt')?.replaceChildren(),
      );
      clearTimeout(back);
      if (p?.autoReturnSec) {
        let n = p.autoReturnSec;
        const tick = () => {
          left.textContent = `New sale in ${n} s`;
          if (n-- <= 0) return newSale();
          back = setTimeout(tick, 1000);
        };
        tick();
      }
      return;
    }
    if (row.state === 'partial') {
      const rest = h('button', { type: 'button', class: 'btn primary big' }, `Wait for the rest (${moneyText(row.owed)})`);
      rest.onclick = () => void busy(rest, async () => void (await shop.requestRest(inv, row.owed)), app.explain);
      const accept = h('button', { type: 'button', class: 'btn' }, 'Accept as is');
      accept.onclick = () => void busy(accept, async () => void (await shop.acceptShort(inv)), app.explain);
      const partials = row.pays.filter((x) => !x.late && x.kind === 'partial' && !x.refundId);
      const ready = partials.every((x) => x.collected);
      stage.replaceChildren(
        h('p', { class: 'cust-label' }, 'Received'),
        h('div', { class: 'cust-total mono' }, `${moneyText(row.paid)} of ${moneyText(t.total)}`),
        inv.requests.length > 1 && inv.creq ? h('div', { class: 'cust-qr' }, qrCard(inv.creq, { label: `Pay the rest of ${inv.number}`, ecc: 'M' }), h('p', { class: 'cust-scan' }, `Scan to pay the rest: ${moneyText(row.owed)}`)) : '',
        h('div', { class: 'cust-actions' }, inv.requests.length > 1 ? '' : rest, accept),
        ready && partials.length
          ? h('div', { class: 'stack' }, ...partials.map((x) => refundBox(app, shop, inv, x.amount, 'partial payment', { ref: `${x.request}:${x.n}`, extra: x.n !== undefined ? { request: x.request, n: x.n } : undefined })))
          : h('p', { class: 'hint' }, waiting('Receiving the payment…')),
      );
      return;
    }
    if (row.state === 'expired' || row.state === 'cancelled') {
      stage.replaceChildren(h('div', { class: 'cust-paid bad' }, svg(ICON.alert), h('h2', null, row.state === 'expired' ? 'Expired' : 'Cancelled')), h('p', { class: 'hint center' }, 'A payment that still arrives can be refunded from the invoice.'), h('div', { class: 'cust-actions' }, h('button', { type: 'button', class: 'btn primary big', onclick: newSale }, 'New sale')));
      return;
    }
    stage.replaceChildren(
      h('p', { class: 'cust-label' }, 'Total'),
      moneyEl(t.total, { cls: 'cust-money' }),
      inv.creq ? h('div', { class: 'cust-qr' }, qrCard(inv.creq, { label: `Pay ${moneyText(t.total)} to ${p?.name ?? 'the shop'}`, ecc: 'M' })) : '',
      h('p', { class: 'cust-scan' }, 'Scan with your wallet to pay'),
      h('p', { class: 'hint center' }, 'Expires in ', ((timer.textContent = countdownTo(inv.expiresAt)), timer)),
      h('div', { class: 'status-line' }, waiting('Waiting for payment…')),
    );
  };

  const cancel = h('button', { type: 'button', class: 'btn ghost cust-cancel' }, 'Cancel');
  cancel.onclick = () => {
    const inv = shop.get(inv0.id) ?? inv0;
    const row = shop.rows().find((r) => r.inv.id === inv.id)!;
    if (row.state === 'paid' || row.state === 'overpaid' || row.state === 'expired' || row.state === 'cancelled') return newSale();
    const yes = h('button', { type: 'button', class: 'btn danger' }, 'Yes, cancel the sale');
    yes.onclick = () => void busy(yes, async () => (await shop.cancel(inv), newSale()), app.explain);
    const keep = h('button', { type: 'button', class: 'btn ghost' }, 'Keep waiting');
    const ask = h('div', { class: 'ask' }, h('p', null, 'Cancel this sale? A payment that still arrives can be refunded.'), h('div', { class: 'row' }, yes, keep));
    keep.onclick = () => ask.remove();
    stage.append(ask);
  };

  draw();
  const tick = () => {
    const inv = shop.get(inv0.id);
    if (inv) void app.posreq.collectAll((r) => inv.requests.includes(r.id), 5000);
  };
  tick();
  ticking = setInterval(() => {
    timer.textContent = countdownTo((shop.get(inv0.id) ?? inv0).expiresAt);
    draw();
  }, 1000);
  const collector = setInterval(tick, 3000);
  const off = [shop.on(draw), app.onChange(draw)];
  const el = h('div', { class: 'customer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Customer screen' }, h('div', { class: 'cust-top' }, head, cancel), stage);
  return {
    el,
    cleanup: () => {
      clearInterval(ticking);
      clearInterval(collector);
      clearTimeout(back);
      off.forEach((f) => f());
      release?.();
    },
  };
}
