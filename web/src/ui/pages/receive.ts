import type { ExtraPayment, PosRecord } from '../../wallet/posreq';
import { PosOfflineError } from '../../wallet/pos';
import { busy, copyChip, copyText, h, svg, ICON } from '../dom';
import { backupNudge, handleCode, scanBlock, type Ctx } from '../flows';
import { qrCard } from '../qr';
import { go } from '../router';
import { amountEntry, details, field, kv, moneyEl, pageHead, resultView, waiting, type App, type Page } from '../widgets';
import { moneyText } from '../words';

export const receive: Page = {
  title: 'Receive',
  render(app, route) {
    const id = route.params.get('r');
    const rec = id ? app.posreq.records().find((r) => r.id === id) : undefined;
    return rec ? requestView(app, rec) : start(app);
  },
};

const online = (app: App) => navigator.onLine && app.core.mintUp() !== false;

function start(app: App) {
  const body = h('div', { class: 'flow' });
  const ctx: Ctx = { app, show: (v) => body.replaceChildren(v), restart: () => draw() };
  const scanner = () => {
    const s = scanBlock({ label: 'Scan their code', prompt: 'Point the camera at their code', onText: (t) => handleCode(ctx, t, 'receive', s.say) });
    return s;
  };

  const draw = () => {
    const mine = h('button', { type: 'button', class: 'btn block big' }, svg(ICON.request), 'Show my code');
    mine.onclick = () => (online(app) ? askAmount() : keyView('offline'));
    body.replaceChildren(h('div', { class: 'choices' }, scanner().el, h('div', { class: 'or', 'aria-hidden': 'true' }, 'or'), mine));
  };

  /** Optional amount, then a payment code locked to a fresh key; no amount: the key code. */
  const askAmount = () => {
    const amount = amountEntry({ optional: true, autofocus: true, label: 'Amount (optional)' });
    const show = h('button', { type: 'submit', class: 'btn primary block big' }, 'Show code');
    const form = h(
      'form',
      {
        class: 'confirm',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          let zat: number | null;
          try {
            zat = amount.zat();
          } catch {
            return;
          }
          if (zat === null) return keyView('no-amount');
          void busy(
            show,
            async () => {
              try {
                const rec = await app.posreq.create(zat!);
                go(`/receive?r=${encodeURIComponent(rec.id)}`);
              } catch (err) {
                if (err instanceof PosOfflineError || app.core.isNetworkError(err)) return keyView(navigator.onLine ? 'no-service' : 'offline');
                throw err;
              }
            },
            app.explain,
          );
        },
      },
      h('p', { class: 'confirm-label' }, 'How much? (optional)'),
      amount.el,
      h('div', { class: 'confirm-actions' }, show, h('button', { type: 'button', class: 'btn ghost', onclick: draw }, 'Cancel')),
    );
    ctx.show(form);
    amount.input.focus();
  };

  /** This wallet's key as a QR: they lock money to it and show a code back, which works offline. */
  const keyView = (why: 'offline' | 'no-amount' | 'no-service') => {
    const pub = app.core.me.pub;
    const line = {
      offline: 'You’re offline. They scan this, then show you a code back: scan it to receive.',
      'no-amount': 'They scan this and choose the amount, then show you a code back: scan it to receive.',
      'no-service': 'Payment codes are unavailable right now. They scan this, then show you a code back: scan it to receive.',
    }[why];
    ctx.show(
      h(
        'div',
        { class: 'flow' },
        qrCard(pub, { label: 'QR code of your receive code', ecc: 'M' }),
        h('p', { class: 'warn-line info' }, line),
        scanner().el,
        details(kv('Your key', copyChip(pub, 'Key', 10, 8)), h('p', { class: 'hint' }, 'Your public key. Tokens locked to it (P2PK) with DLEQ proofs can be received with no network and are redeemed when you are back online.')),
      ),
    );
  };

  draw();
  return { el: h('div', { class: 'page' }, pageHead('Receive'), body) };
}

/** Total of partial payments on a request that is still unpaid. */
const partialSum = (r: PosRecord) => (r.extras ?? []).filter((x) => x.kind === 'partial').reduce((a, x) => a + x.received, 0);

/** "Extra payment received: <amount>" or "Partial payment received: X of Y", its state, and
 * Refund (unlocked, or locked to the payer's key). */
function extraRow(app: App, rec: PosRecord, x: ExtraPayment) {
  const amount = x.collected ?? x.received;
  const partial = x.kind === 'partial';
  const status = x.refundId ? 'refunded' : x.state === 'done' ? 'in your wallet' : 'receiving…';
  const title = partial ? `Partial payment received: ${moneyText(x.received)} of ${moneyText(rec.amount)}` : `Extra payment received: ${moneyText(x.received)}`;
  const head = h('div', { class: 'extra-head' }, h('strong', null, title), h('span', { class: `hint t-${x.refundId ? 'muted' : x.state === 'done' ? 'ok' : 'live'}` }, status));
  const why = partial
    ? 'Less than you asked for, so it doesn’t pay your code. It’s yours; refund it if they should pay the full amount instead.'
    : 'Your code was already paid when this arrived. It’s yours; if they paid twice by mistake, refund it.';
  const box = h('div', { class: `extra ${partial ? 'partial' : ''}` }, head, h('p', { class: 'hint' }, why));
  if (x.refundId) {
    box.append(h('a', { href: `#/send?t=${encodeURIComponent(x.refundId)}`, class: 'btn block ghost' }, 'Show the refund code'));
    return box;
  }
  if (x.state !== 'done') return box;
  const pub = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', placeholder: 'optional: 02… or 03…' });
  const make = h('button', { type: 'button', class: 'btn primary block' }, `Make a refund code for ${moneyText(amount)}`);
  const form = h(
    'div',
    { class: 'stack', hidden: true },
    field('Their receive code (optional)', pub, 'With it, only they can take the refund. Without it, anyone holding the refund code can.'),
    make,
  );
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
      },
      app.explain,
    );
  box.append(h('div', { class: 'row' }, refund), form);
  return box;
}

/** A payment code this phone showed: the QR until paid, then Received; extra and partial payments. */
function requestView(app: App, r0: PosRecord) {
  const top = h('div', { class: 'flow' });
  const err = h('p', { class: 'inline-msg t-bad' });
  const extrasBox = h('div');
  /** "Received X of Y" above the QR while partial payments are in. */
  const partialLine = h('p', { class: 'partial-line mono', hidden: true });
  const state = h('div', { class: 'status-line' });
  let pay: HTMLElement | null = null;
  if (r0.request) {
    const share = 'share' in navigator ? h('button', { type: 'button', class: 'btn' }, svg(ICON.share), 'Share') : null;
    if (share) share.onclick = () => void navigator.share({ text: r0.request! }).catch(() => {});
    pay = h(
      'div',
      { class: 'flow' },
      moneyEl(r0.amount, { cls: 'code-money' }),
      partialLine,
      qrCard(r0.request, { label: `QR code asking for ${moneyText(r0.amount)}`, ecc: 'M' }),
      h('div', { class: 'row thumb-row' }, share, h('button', { type: 'button', class: 'btn', onclick: () => void copyText(r0.request!, 'Code') }, svg(ICON.copy), 'Copy')),
      state,
    );
  }
  let shown = '';
  let shownExtras = '';
  const render = () => {
    const r = app.posreq.records().find((x) => x.id === r0.id) ?? r0;
    err.textContent = r.state !== 'done' && r.error ? app.explain(new Error(r.error)) : '';
    const exKey = JSON.stringify([r.state, (r.extras ?? []).map((x) => [x.n, x.state, x.refundId])]);
    if (exKey !== shownExtras) {
      shownExtras = exKey;
      const partials = (r.extras ?? []).some((x) => x.kind === 'partial');
      const extras = (r.extras ?? []).some((x) => x.kind !== 'partial');
      extrasBox.replaceChildren(
        r.extras?.length
          ? h('section', { class: 'section' }, h('h2', { class: 'section-title' }, partials ? (extras ? 'Partial and extra payments' : 'Partial payments') : 'Extra payments'), ...r.extras.map((x) => extraRow(app, r, x)))
          : '',
      );
    }
    partialLine.hidden = !(r.state === 'open' && partialSum(r));
    partialLine.textContent = `Received ${moneyText(partialSum(r))} of ${moneyText(r.amount)} · still unpaid`;
    const key = r.state === 'done' ? 'done' : r.state === 'open' ? 'open' : 'paid';
    if (key === shown) return;
    shown = key;
    if (key === 'done') {
      top.replaceChildren(resultView({ ok: true, title: 'Received', zat: r.collected ?? r.received ?? r.amount, sign: '+', extra: backupNudge(app) }));
    } else {
      state.replaceChildren(waiting(key === 'open' ? 'Waiting for payment…' : 'Paid · receiving…'));
      top.replaceChildren(pay ?? h('div', { class: 'status-line' }, waiting('Paid · receiving…')));
    }
  };
  render();
  // While this code is on screen, also ask often for late extra payments.
  const tick = () => void app.posreq.collectAll((x) => x.id === r0.id, 5000);
  tick();
  const timer = setInterval(tick, 3000);
  const el = h(
    'div',
    { class: 'page' },
    pageHead('Receive', { back: true }),
    top,
    err,
    extrasBox,
    details(
      kv('Request', `${r0.id.slice(0, 16)}…`),
      h('p', { class: 'hint' }, 'A NUT-18 payment request locked (P2PK) to a fresh key from this wallet’s seed. The payment service checks each payment and keeps it until this phone collects it; it can never spend it.'),
    ),
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
