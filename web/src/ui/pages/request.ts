import type { PosRecord } from '../../wallet/posreq';
import { posOnline, PosOfflineError } from '../../wallet/pos';
import { ago, busy, copyText, fmtZat, h, svg, toast, ICON } from '../dom';
import { qrCard } from '../qr';
import { go } from '../router';
import { amountField, amountInput, emptyState, field, glitch, pageHead, waiting, type App, type Page } from '../widgets';
import type { ExtraPayment } from '../../wallet/posreq';

export const request: Page = {
  title: 'Request',
  render(app, route) {
    const id = route.params.get('r');
    const rec = id ? app.posreq.records().find((r) => r.id === id) : undefined;
    return rec ? detail(app, rec) : form(app);
  },
};

const STATE_TEXT: Record<PosRecord['state'], string> = {
  open: 'waiting for payment',
  paid: 'paid · collecting',
  collecting: 'paid · collecting',
  collected: 'collected · finishing',
  done: 'collected',
};

function row(r: PosRecord) {
  const amt = r.collected ?? r.received ?? r.amount;
  const tone = r.state === 'done' ? 'ok' : r.state === 'open' ? 'muted' : 'live';
  return h(
    'a',
    { href: `#/request?r=${encodeURIComponent(r.id)}`, class: 'list-row' },
    h('span', { class: 'mono' }, `${fmtZat(amt)} zat`),
    h('span', { class: `hint t-${tone}` }, `${STATE_TEXT[r.state]}${partialNote(r)}${extrasNote(r)} · ${ago(r.paidAt ?? r.created)}`),
  );
}

/** Total of partial payments on a request that is still unpaid. */
const partialSum = (r: PosRecord) => (r.extras ?? []).filter((x) => x.kind === 'partial').reduce((a, x) => a + x.received, 0);
const partialNote = (r: PosRecord) => (r.state === 'open' && partialSum(r) ? ` · received ${fmtZat(partialSum(r))} of ${fmtZat(r.amount)}` : '');
const extrasNote = (r: PosRecord) => {
  const n = (r.extras ?? []).filter((x) => x.kind !== 'partial').length;
  return n ? ` · +${n} extra` : '';
};

/** "Extra payment received: <amount>" or "Partial payment received: X of Y", its state, and
 * Refund (unlocked, or locked to the payer's key). */
function extraRow(app: App, rec: PosRecord, x: ExtraPayment) {
  const amount = x.collected ?? x.received;
  const partial = x.kind === 'partial';
  const status = x.refundId ? 'refunded' : x.state === 'done' ? 'in your wallet' : 'collecting…';
  const title = partial ? `Partial payment received: ${fmtZat(x.received)} of ${fmtZat(rec.amount)} zat` : `Extra payment received: ${fmtZat(x.received)} zat`;
  const head = h('div', { class: 'extra-head' }, h('strong', null, title), h('span', { class: `hint t-${x.refundId ? 'muted' : x.state === 'done' ? 'ok' : 'live'}` }, status));
  const why = partial
    ? 'Less than the request, so it does not pay it. It is yours; refund it if the payer should pay the full amount instead.'
    : 'The request was already paid when this arrived. It is yours; if the payer paid twice by mistake, refund it.';
  const box = h('div', { class: `extra ${partial ? 'partial' : ''}` }, head, h('p', { class: 'hint' }, why));
  if (x.refundId) {
    box.append(h('a', { href: `#/send?t=${encodeURIComponent(x.refundId)}`, class: 'btn block ghost' }, 'Show the refund token'));
    return box;
  }
  if (x.state !== 'done') return box;
  const pub = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', placeholder: 'optional: 02… or 03… (the payer’s key)' });
  const make = h('button', { type: 'button', class: 'btn primary block' }, `Create refund token (${fmtZat(amount)} zat)`);
  const form = h('div', { class: 'stack', hidden: true }, field('Lock the refund to the payer’s public key', pub, 'Leave empty for an unlocked token: whoever holds it can redeem it.'), make);
  const refund = h('button', { type: 'button', class: 'btn danger-outline' }, 'Refund');
  refund.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) pub.focus();
  };
  make.onclick = () =>
    void busy(
      make,
      async () => {
        const lockTo = pub.value.trim() || undefined;
        const item = await app.tokens.send(amount, { compact: false, lockTo });
        app.posreq.markRefunded(rec.id, x.n, item.id);
        go(`/send?t=${encodeURIComponent(item.id)}`);
        toast(`Refund token for ${fmtZat(amount)} zat created${lockTo ? ', locked to the payer’s key' : ''}. Hand it back to the payer.`, 'ok');
      },
      app.core.explain,
    );
  box.append(h('div', { class: 'row' }, refund), form);
  return box;
}

function form(app: App) {
  const amount = amountInput();
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, '[ CREATE REQUEST ]');
  const offline = h('div', { class: 'pos-offline', role: 'status', hidden: true }, h('strong', null, 'Point of sale is offline'), h('p', null, 'Payment requests can’t be created right now. This page checks again by itself.'));
  const lists = h('div');
  let up: boolean | null = null;

  /** Offline: say so and disable Create request. */
  const setUp = (v: boolean) => {
    up = v;
    offline.hidden = v;
    submit.disabled = !v;
    submit.setAttribute('aria-disabled', String(!v));
  };
  const probe = async () => setUp(await posOnline());
  submit.disabled = true; // until the first health check answers
  void probe();

  const update = () => {
    const recs = app.posreq.records();
    const todo = app.posreq.uncollected();
    lists.replaceChildren(
      todo.length
        ? h('section', { class: 'section' }, h('h3', { class: 'section-title' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), `To collect · ${todo.length}`), h('p', { class: 'hint' }, 'Paid, and collected into this wallet automatically while the app is open.'), h('div', { class: 'list' }, todo.map(row)))
        : '',
      h('section', { class: 'section' }, h('h3', { class: 'section-title' }, 'Your requests'), recs.length ? h('div', { class: 'list' }, recs.slice(0, 12).map(row)) : emptyState('No requests yet.')),
    );
  };
  update();
  void app.posreq.collectAll();
  const timers = [setInterval(() => void probe(), 15_000), setInterval(() => app.posreq.uncollected().length && void app.posreq.collectAll(), 5000)];

  const el = h(
    'div',
    { class: 'page' },
    pageHead('REQUEST', 'Request payment', 'A NUT-18 request locked to a fresh key that only this phone holds. The shop’s server checks and keeps the payment until this phone collects it; it can never spend it.'),
    offline,
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          if (up === false) return;
          void busy(
            submit,
            async () => {
              try {
                const rec = await app.posreq.create(Number(amount.value));
                go(`/request?r=${encodeURIComponent(rec.id)}`, true);
              } catch (e) {
                if (e instanceof PosOfflineError) setUp(false);
                throw e;
              }
            },
            app.core.explain,
          ).then(() => up === false && setUp(false)); // busy() re-enables the button; offline wins
        },
      },
      amountField('Amount', amount),
      h('div', { class: 'thumb' }, submit),
    ),
    lists,
  );
  const off = app.onChange(update);
  return {
    el,
    cleanup: () => {
      timers.forEach(clearInterval);
      off();
    },
  };
}

function detail(app: App, r0: PosRecord) {
  const state = h('div', { class: 'status-line big' });
  const pay = h('div', { class: 'pay' });
  const note = h('p', { class: 'hint center' });
  const err = h('p', { class: 'inline-msg t-bad' });
  const extrasBox = h('div');
  /** "Received X of Y" above the QR while partial payments are in. */
  const partialLine = h('p', { class: 'partial-line mono', hidden: true });
  let shown = '';
  let shownExtras = '';
  if (r0.request) {
    pay.append(
      qrCard(r0.request, { label: `QR code of a payment request for ${r0.amount} zat`, ecc: 'M' }),
      h('div', { class: 'row wrap thumb-row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => void copyText(r0.request!, 'Request') }, svg(ICON.copy), 'Copy request')),
      h('details', { class: 'details' }, h('summary', null, 'Show request text'), h('textarea', { class: 'input mono', rows: '4', readonly: true, 'aria-label': 'Request text', value: r0.request })),
    );
  }
  const render = () => {
    const r = app.posreq.records().find((x) => x.id === r0.id) ?? r0;
    err.textContent = r.state !== 'done' && r.error ? r.error : '';
    const exKey = JSON.stringify([r.state, (r.extras ?? []).map((x) => [x.n, x.state, x.refundId])]);
    if (exKey !== shownExtras) {
      shownExtras = exKey;
      extrasBox.replaceChildren(
        r.extras?.length
          ? h(
              'section',
              { class: 'section' },
              h('h3', { class: 'section-title' }, `${r.extras.some((x) => x.kind === 'partial') ? (r.extras.some((x) => x.kind !== 'partial') ? 'Partial and extra' : 'Partial') : 'Extra'} payments · ${r.extras.length}`),
              ...r.extras.map((x) => extraRow(app, r, x)),
            )
          : '',
      );
    }
    partialLine.hidden = !(r.state === 'open' && partialSum(r));
    partialLine.textContent = `Received ${fmtZat(partialSum(r))} of ${fmtZat(r.amount)} zat · still unpaid`;
    const key = `${r.state}:${partialSum(r)}`;
    if (key === shown) return;
    shown = key;
    pay.hidden = r.state !== 'open' || !r.request;
    state.replaceChildren(
      r.state === 'open'
        ? waiting('WAITING FOR PAYMENT')
        : r.state === 'done'
          ? h('span', null, glitch('COLLECTED', 't-live'), h('span', { class: 'mono minted' }, ` +${fmtZat(r.collected ?? r.received ?? r.amount)} zat`))
          : waiting('PAID · COLLECTING'),
    );
    note.textContent =
      r.state === 'open' && partialSum(r)
        ? `Received ${fmtZat(partialSum(r))} of ${fmtZat(r.amount)} zat in partial payments: the request is still unpaid.`
        : r.state === 'open'
        ? 'Have the payer scan it. Their wallet locks the ecash to a key only this phone holds.'
        : r.state === 'done'
          ? `In this wallet${r.collected !== undefined ? `: ${fmtZat(r.collected)} zat` : ''}. The shop’s server has deleted its copy.`
          : `Paid ${fmtZat(r.received ?? r.amount)} zat. Collecting it into this wallet; this resumes by itself after a reload or when you are back online.`;
  };
  render();
  // While this request is on screen, also ask often for late extra payments.
  const tick = () => void app.posreq.collectAll((x) => x.id === r0.id, 5000);
  tick();
  const timer = setInterval(tick, 3000);
  const el = h(
    'div',
    { class: 'page' },
    pageHead('REQUEST', `${fmtZat(r0.amount)} zat`, 'Locked to a fresh key from this wallet’s seed'),
    partialLine,
    pay,
    state,
    note,
    err,
    extrasBox,
    h('p', { class: 'hint center mono' }, `request ${r0.id.slice(0, 16)}…`),
    h('a', { href: '#/request', class: 'btn block ghost' }, 'New request'),
  );
  const off = app.onChange(render);
  return {
    el,
    cleanup: () => {
      clearInterval(timer);
      off();
    },
  };
}
