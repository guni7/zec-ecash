import type { ExtraPayment, PosRecord } from '../../wallet/posreq';
import { posOnline } from '../../wallet/pos';
import { choice, onConnectivity, online } from './send';
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
    return rec ? requestView(app, rec, Number(route.params.get('served') ?? 0)) : start(app, route.params.get('do'));
  },
};

/** `open`: a choice to open straight away (deep links, e.g. the judges' tour): request | without. */
function start(app: App, open?: string | null) {
  const body = h('div', { class: 'flow' });
  let mode: 'start' | 'flow' = 'start';
  const ctx: Ctx = {
    app,
    show: (v) => {
      mode = 'flow';
      body.replaceChildren(v);
    },
    restart: () => draw(),
  };
  const scanner = (primary = true) => {
    const s = scanBlock({ label: 'Scan their code', prompt: 'Point the camera at their code', primary, onText: (t) => handleCode(ctx, t, 'receive', s.say) });
    return s;
  };
  /** Is the payment-request service up? null until the first check answers. */
  let posUp: boolean | null = null;
  const probe = async () => {
    const up = await posOnline();
    if (up !== posUp) {
      posUp = up;
      if (mode === 'start') draw();
    }
  };

  /** Three choices; offline, "without internet" first, and Request an amount greyed with why. */
  const draw = () => {
    mode = 'start';
    const up = online(app);
    const request = choice('Request an amount', ICON.request, {
      off: !up ? 'Needs a connection.' : posUp === false ? 'Payment requests are unavailable right now; Receive without internet still works.' : undefined,
      onclick: askAmount,
    });
    const without = choice('Receive without internet', ICON.receive, { primary: !up, onclick: keyView });
    const or = () => h('div', { class: 'or', 'aria-hidden': 'true' }, 'or');
    body.replaceChildren(
      up ? '' : h('p', { class: 'offline-note', role: 'status' }, 'You’re offline. You can still receive money locked to you: show your code, then scan theirs.'),
      h('div', { class: 'choices' }, ...(up ? [scanner().el, or(), request, without] : [without, scanner(false).el, request])),
    );
  };

  /** An amount, then a payment request (NUT-18) locked to a fresh key; shop mode keeps it open. */
  const askAmount = () => {
    const amount = amountEntry({ autofocus: true });
    const shop = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!app.prefs.get().shop });
    shop.onchange = () => app.prefs.set({ shop: shop.checked });
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
          void busy(
            show,
            async () => {
              const rec = await app.posreq.create(zat!);
              go(`/receive?r=${encodeURIComponent(rec.id)}`);
            },
            app.explain,
          );
        },
      },
      h('p', { class: 'confirm-label' }, 'Request an amount'),
      amount.el,
      h('label', { class: 'toggle' }, shop, h('span', null, h('strong', null, 'Keep open for the next customer'), h('small', null, 'After each payment, a new request for the same amount appears.'))),
      h('div', { class: 'confirm-actions' }, show, h('button', { type: 'button', class: 'btn ghost', onclick: draw }, 'Cancel')),
    );
    ctx.show(form);
  };

  /** This wallet's key as a QR: they lock money to it and show a code back, which works offline. */
  const keyView = () => {
    const pub = app.core.me.pub;
    ctx.show(
      h(
        'div',
        { class: 'flow' },
        h('p', { class: 'confirm-label' }, 'Receive without internet'),
        qrCard(pub, { label: 'QR code of your receive code', ecc: 'M' }),
        h('p', { class: 'warn-line info' }, 'They’ll scan this, then show you a code back to scan.'),
        scanner().el,
        details(kv('Your key', copyChip(pub, 'Key', 10, 8)), h('p', { class: 'hint' }, 'Your public key. Tokens locked to it (P2PK) with DLEQ proofs can be received with no network and are redeemed when you are back online.')),
        h('button', { type: 'button', class: 'btn ghost block', onclick: draw }, 'Back'),
      ),
    );
  };

  draw();
  if (open === 'without') keyView();
  else if (open === 'request' && online(app)) askAmount();
  void probe();
  const timer = setInterval(() => online(app) && void probe(), 15_000);
  const offNet = onConnectivity(app, () => {
    if (mode === 'start') draw();
    if (online(app)) void probe();
  });
  return {
    el: h('div', { class: 'page' }, pageHead('Receive'), body),
    cleanup: () => {
      clearInterval(timer);
      offNet();
    },
  };
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
function requestView(app: App, r0: PosRecord, served: number) {
  const top = h('div', { class: 'flow' });
  /** Shop mode: after each payment, a new request for the same amount ("Keep open for the next customer"). */
  const shopBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: !!app.prefs.get().shop });
  const shopLine = h('span', { class: 'shop-count mono' });
  const showShop = () => (shopLine.textContent = app.prefs.get().shop ? `Shop mode · ${served} paid` : '');
  shopBox.onchange = () => {
    app.prefs.set({ shop: shopBox.checked });
    showShop();
  };
  showShop();
  const shopToggle = h('label', { class: 'toggle' }, shopBox, h('span', null, h('strong', null, 'Keep open for the next customer'), h('small', null, 'After each payment, a new request for the same amount appears.')));
  let next: ReturnType<typeof setTimeout> | undefined;
  /** Paid, in shop mode: count down, then the next request for the same amount. */
  const nextCustomer = (zat: number) => {
    const line = h('span', null, 'Next customer in 3…');
    const stop = h('button', { type: 'button', class: 'btn block' }, 'Stop');
    shopLine.textContent = `Shop mode · ${served + 1} paid`;
    top.replaceChildren(resultView({ ok: true, title: 'Paid ✓', zat, sign: '+', text: line, actions: [stop] }));
    let n = 3;
    const tick = () => {
      if (--n > 0) {
        line.textContent = `Next customer in ${n}…`;
        next = setTimeout(tick, 1000);
        return;
      }
      line.textContent = 'Opening the next request…';
      app.posreq.create(r0.amount).then(
        (rec) => go(`/receive?r=${encodeURIComponent(rec.id)}&served=${served + 1}`, true),
        (e) => {
          line.textContent = app.explain(e);
          const again = h('button', { type: 'button', class: 'btn primary block' }, 'Try again');
          again.onclick = () => nextCustomer(zat);
          stop.before(again);
        },
      );
    };
    next = setTimeout(tick, 1000);
    stop.onclick = () => {
      clearTimeout(next);
      app.prefs.set({ shop: false });
      shopBox.checked = false;
      showShop();
      line.textContent = 'Shop mode stopped.';
      stop.remove();
    };
  };
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
      shopToggle,
    );
  }
  let shown = '';
  let shownExtras = '';
  /** Shop mode moves on only from a payment seen arriving here, not when reopening a paid request. */
  const sawOpen = r0.state === 'open';
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
    if (key === shown || shown === 'next') return;
    shown = key;
    // A shop doesn't wait for the money to be collected: it's paid, so the next customer is up.
    if (key !== 'open' && app.prefs.get().shop && sawOpen) {
      shown = 'next';
      return nextCustomer(r.received ?? r.amount);
    }
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
    pageHead('Receive', { back: true, right: shopLine }),
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
      clearTimeout(next);
      off();
    },
  };
}
