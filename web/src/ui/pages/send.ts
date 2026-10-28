import type { SentToken } from '../../wallet/tokens';
import { busy, copyChip, copyText, h, svg, toast, ICON } from '../dom';
import { handleCode, scanBlock, type Ctx } from '../flows';
import { qrCard } from '../qr';
import { go } from '../router';
import { amountEntry, details, kv, moneyEl, pageHead, resultView, waiting, type App, type Page } from '../widgets';
import { moneyText } from '../words';

export const send: Page = {
  title: 'Send',
  render(app, route) {
    const id = route.params.get('t');
    const token = id ? app.tokens.sent().find((s) => s.id === id) : undefined;
    if (id && token) return tokenView(app, token, route.params.get('r'));
    return start(app, route.params.get('do'));
  },
};

/** Compact (no DLEQ proofs, half the size) only for unlocked codes made online; Settings can turn it off. */
const autoCompact = (app: App) => app.core.settings().compact && navigator.onLine && app.core.mintUp() !== false;

/** Connected: the network is up and the mint answers (null: not asked yet). */
export const online = (app: App) => navigator.onLine && app.core.mintUp() !== false;

/** A big choice button; disabled with a short reason under it. */
export function choice(label: string, icon: string, opts: { primary?: boolean; off?: string; onclick: () => void }) {
  const btn = h('button', { type: 'button', class: `btn block big ${opts.primary ? 'primary' : ''}`, disabled: !!opts.off }, svg(icon), label);
  btn.onclick = opts.onclick;
  return h('div', { class: 'choice' }, btn, opts.off ? h('p', { class: 'choice-off' }, opts.off) : null);
}

/** Redraws `draw` when the connection comes or goes; returns the cleanup. */
export function onConnectivity(app: App, draw: () => void) {
  addEventListener('online', draw);
  addEventListener('offline', draw);
  const off = app.core.on((e) => e.type === 'mint' && draw());
  return () => {
    removeEventListener('online', draw);
    removeEventListener('offline', draw);
    off();
  };
}

/** `open`: a choice to open straight away (deep links, e.g. the judges' tour): show | without. */
function start(app: App, open?: string | null) {
  const body = h('div', { class: 'flow' });
  /** What is showing: no money yet, the three choices, or a flow (the amount, a confirmation). */
  let mode: 'empty' | 'start' | 'flow' = 'start';
  const ctx: Ctx = {
    app,
    show: (v) => {
      mode = 'flow';
      body.replaceChildren(v);
    },
    restart: () => draw(),
  };
  /** Three choices; offline, "without internet" first and the rest greyed with why. */
  const draw = () => {
    if (app.core.balance() === 0) {
      mode = 'empty';
      body.replaceChildren(h('div', { class: 'empty start' }, h('p', null, 'You have no money to send yet.'), h('a', { href: '#/deposit', class: 'btn primary block big' }, svg(ICON.deposit), 'Add money')));
      return;
    }
    mode = 'start';
    const up = online(app);
    const needNet = up ? undefined : 'Needs a connection.';
    const scan = scanBlock({ label: 'Scan their code', prompt: 'Point the camera at their code', onText: (t) => handleCode(ctx, t, 'send', scan.say) });
    if (!up) {
      scan.scan.disabled = true;
      scan.el.querySelector('.link-btn')?.setAttribute('hidden', '');
      scan.el.append(h('p', { class: 'choice-off' }, needNet!));
    }
    const show = choice('Show a code', ICON.request, { off: needNet, onclick: () => ctx.show(showAmount()) });
    const without = choice('Send without internet', ICON.send, {
      off: up ? undefined : 'Your phone needs a connection for a moment to lock the money to them; their phone can stay offline.',
      onclick: () => ctx.show(sendOffline()),
    });
    const or = () => h('div', { class: 'or', 'aria-hidden': 'true' }, 'or');
    body.replaceChildren(
      up ? '' : h('p', { class: 'offline-note', role: 'status' }, 'You’re offline. Sending needs a connection; the person you pay can be offline.'),
      h('div', { class: 'choices' }, ...(up ? [scan.el, or(), show, without] : [without, scan.el, show])),
    );
  };
  /** How much, then the code anyone can take. */
  const showAmount = () => {
    const amount = amountEntry({ max: () => app.core.balance(), autofocus: true });
    const make = h('button', { type: 'submit', class: 'btn primary block big' }, 'Show code');
    return h(
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
            make,
            async () => {
              const item = await app.tokens.send(zat!, { compact: autoCompact(app) });
              go(`/send?t=${encodeURIComponent(item.id)}`);
            },
            app.explain,
          );
        },
      },
      h('p', { class: 'confirm-label' }, 'How much?'),
      amount.el,
      h('div', { class: 'confirm-actions' }, make, h('button', { type: 'button', class: 'btn ghost', onclick: () => draw() }, 'Cancel')),
    );
  };
  /** For someone with no internet: scan their receive code, then the amount, then a locked code. */
  const sendOffline = () => {
    const scan = scanBlock({ label: 'Scan their code', prompt: 'Point the camera at their receive code', onText: (t) => handleCode(ctx, t, 'send', scan.say) });
    return h(
      'div',
      { class: 'confirm' },
      h('p', { class: 'confirm-label' }, 'Send without internet'),
      h('p', { class: 'warn-line info' }, 'Ask them to open Receive → Receive without internet, then scan their code.'),
      scan.el,
      h('button', { type: 'button', class: 'btn ghost block', onclick: () => draw() }, 'Cancel'),
    );
  };
  draw();
  if (mode === 'start' && open === 'show' && online(app)) ctx.show(showAmount());
  else if (mode === 'start' && open === 'without' && online(app)) ctx.show(sendOffline());
  const el = h('div', { class: 'page' }, pageHead('Send'), body);
  const offNet = onConnectivity(app, () => mode !== 'flow' && draw());
  const off = app.onChange(() => mode === 'empty' && app.core.balance() > 0 && draw());
  return {
    el,
    cleanup: () => {
      offNet();
      off();
    },
  };
}

/** A code made on this phone: shown until it is picked up, or the result of paying someone's code. */
function tokenView(app: App, s0: SentToken, outcome: string | null) {
  const body = h('div', { class: 'flow' });
  let shown = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const current = () => app.tokens.sent().find((x) => x.id === s0.id) ?? s0;

  const draw = () => {
    const s = current();
    const key = `${s.state}:${s.deliveryError ?? ''}`;
    if (key === shown) return;
    shown = key;
    if (s.state !== 'pending') clearInterval(timer);
    if (s.request) body.replaceChildren(requestResult(app, s, outcome));
    else if (s.state === 'pending') body.replaceChildren(...showing(app, s));
    else if (s.state === 'received') body.replaceChildren(resultView({ ok: true, title: 'Picked up ✓', zat: s.amount, sign: '−', text: 'They have the money.' }));
    else body.replaceChildren(resultView({ ok: true, title: 'Taken back', zat: s.amount, sign: '+', text: 'The money is back in your wallet; the code no longer works.' }));
  };
  draw();
  // Watch for the pickup while the code is on screen.
  if (s0.state === 'pending' && !s0.request) timer = setInterval(() => void app.tokens.refresh(s0.id).catch(() => {}), 3000);
  const el = h('div', { class: 'page' }, pageHead('Send', { back: true }), body);
  const off = app.onChange(draw);
  return {
    el,
    cleanup: () => {
      clearInterval(timer);
      off();
    },
  };
}

function showing(app: App, s: SentToken): Node[] {
  const share = 'share' in navigator ? h('button', { type: 'button', class: 'btn' }, svg(ICON.share), 'Share') : null;
  if (share) share.onclick = () => void navigator.share({ text: s.token }).catch(() => {});
  const copy = h('button', { type: 'button', class: 'btn' }, svg(ICON.copy), 'Copy');
  copy.onclick = () => void copyText(s.token, 'Code');

  const cancelArea = h('div', { class: 'stack' });
  if (!s.lockedTo) {
    const ask = h('button', { type: 'button', class: 'btn block danger-outline' }, 'Take it back');
    ask.onclick = () => {
      const yes = h('button', { type: 'button', class: 'btn danger' }, 'Yes, take it back');
      const no = h('button', { type: 'button', class: 'btn ghost' }, 'Keep it');
      no.onclick = () => cancelArea.replaceChildren(ask);
      yes.onclick = () => void busy(yes, async () => void (await app.tokens.reclaim(s.id)), app.explain);
      cancelArea.replaceChildren(h('div', { class: 'ask', role: 'alertdialog', 'aria-label': 'Take the money back?' }, h('p', null, 'Take the money back? This code stops working.'), h('div', { class: 'row' }, yes, no)));
      yes.focus();
    };
    cancelArea.append(ask);
  }

  const check = h('button', { type: 'button', class: 'btn' }, 'Check now');
  check.onclick = () =>
    void busy(check, async () => {
      const r = await app.tokens.refresh(s.id);
      if (r?.state === 'pending') toast('Not picked up yet.');
    }, app.explain);
  const mark = h('button', { type: 'button', class: 'btn' }, 'Mark as picked up');
  mark.onclick = () => app.tokens.markReceived(s.id);

  return [
    moneyEl(s.amount, { cls: 'code-money' }),
    qrCard(s.token, { label: `QR code for ${moneyText(s.amount)}`, ecc: 'L' }),
    sizeNote(s),
    h('div', { class: 'row thumb-row' }, share, copy),
    h('p', { class: 'warn-line' }, s.lockedTo ? 'Show this to them. Only they can take this money.' : 'Anyone who scans this can take the money, like handing over cash.'),
    h('div', { class: 'status-line' }, waiting('Waiting for them…')),
    cancelArea,
    details(
      kv('Kind', s.lockedTo ? 'locked (P2PK), with DLEQ proofs' : s.compact ? 'compact token (no DLEQ proofs)' : 'token with DLEQ proofs'),
      s.lockedTo ? kv('Locked to', copyChip(s.lockedTo, 'Key', 8, 6)) : null,
      h('textarea', { class: 'input mono', rows: '4', readonly: true, spellcheck: 'false', 'aria-label': 'Code text', value: s.token }),
      h('div', { class: 'row wrap' }, check, mark),
    ),
  ];
}

/**
 * Why this QR code is as dense as it is: the code carries the coins themselves (proofs, powers of
 * two), so its size grows with how many there are; codes with DLEQ proofs carry one per coin too.
 */
function sizeNote(s: SentToken): HTMLElement {
  const coins = s.proofs.length;
  return h(
    'p',
    { class: 'hint qr-size-note' },
    `Smaller amounts are easier to scan. This code is the money itself${coins ? `: ${coins} ${coins === 1 ? 'coin' : 'coins'}` : ''}, and every coin makes the QR code denser. Amounts are made of coins of 1, 2, 4, 8, 16… zats, so a smaller amount usually needs fewer coins.`,
    s.compact ? '' : ' This code also carries a proof for each coin, so it can be checked offline, which makes it bigger still.',
  );
}

/** Paying someone's code: Paid (plain or as an extra or partial payment), or not delivered yet. */
function requestResult(app: App, s: SentToken, outcome: string | null): Node {
  if (s.state === 'received') {
    const text =
      outcome === 'EXTRA'
        ? 'Their code was already paid, so they got this as an extra payment. They can refund it.'
        : outcome === 'PARTIAL'
          ? 'This is less than their code asks for, so it is still unpaid. They can refund it.'
          : s.request?.description
            ? `“${s.request.description}”`
            : undefined;
    return resultView({ ok: true, title: 'Paid', zat: s.amount, sign: '−', text });
  }
  const again = h('button', { type: 'button', class: 'btn primary block' }, 'Try again');
  again.onclick = () =>
    void busy(again, async () => {
      const r = await app.tokens.redeliver(s.id);
      if (!r.ok) toast(app.explain(new Error(r.message)), 'bad');
    }, app.explain);
  return h(
    'div',
    { class: 'flow' },
    resultView({
      ok: false,
      title: 'Not delivered yet',
      zat: s.amount,
      text: `${s.deliveryError ? app.explain(new Error(s.deliveryError)) : 'Their payment service didn’t answer.'} The payment is saved here; only they can take it.`,
      actions: [again],
    }),
    details(h('p', { class: 'hint' }, 'If their service can’t take it, show them this token: it is locked to their key (P2PK).'), h('textarea', { class: 'input mono', rows: '4', readonly: true, 'aria-label': 'Code text', value: s.token })),
  );
}
