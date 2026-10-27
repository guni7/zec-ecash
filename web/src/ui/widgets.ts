// Pieces shared by the pages, and the App every page receives.
import type { FeedItem } from '../wallet/activity';
import type { Core } from '../wallet/core';
import type { Tokens } from '../wallet/tokens';
import type { PosRequests } from '../wallet/posreq';
import type { initOnchain } from '../wallet/onchain';
import { ago, h, svg, ICON } from './dom';
import type { PrefStore } from './prefs';
import { back, type Route } from './router';
import { amountForInput, inputUnit, money, moneyText, parseAmount, zatsText, zecText } from './words';

export type Onchain = ReturnType<typeof initOnchain>;

export type App = {
  core: Core;
  tokens: Tokens;
  onchain: Onchain;
  posreq: PosRequests;
  prefs: PrefStore;
  feed(): FeedItem[];
  /** Any failure as a plain sentence that says what to do next. */
  explain(e: unknown): string;
  /** Shop mode on (the shop's navigation, opening at Charge) or off (the personal wallet). */
  setShopMode(on: boolean): void;
  /** Calls `fn` on any wallet change (balance, deposits, withdrawals, sends); returns unsubscribe. */
  onChange(fn: () => void): () => void;
};

/** What a page module exports. `render` returns the page element and an optional cleanup. */
export type Page = {
  title: string;
  render(app: App, route: Route): { el: HTMLElement; cleanup?: () => void };
};

let uid = 0;
/** A labelled field: <label> + control + optional hint. */
export function field(label: string, control: HTMLElement, hint?: string | HTMLElement) {
  const id = control.id || (control.id = `f${++uid}`);
  const hintEl = hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintEl);
}

/** The page's one title; a back arrow off the tab pages; something on the right (Home's gear). */
export function pageHead(title: string, opts: { back?: boolean; right?: Node | null; hidden?: boolean } = {}) {
  const t = h('h1', { class: `page-title ${opts.hidden ? 'visually-hidden' : ''}`, tabindex: '-1' }, title);
  return h(
    'div',
    { class: 'page-head' },
    opts.back ? h('button', { type: 'button', class: 'icon-btn back', 'aria-label': 'Back', onclick: () => back() }, svg(ICON.back)) : null,
    t,
    opts.right ?? null,
  );
}

/** An amount on two lines: "0.0006 ZEC" over "60,000 zats" (or zats first). */
export function moneyEl(zat: number, opts: { sign?: '+' | '−' | ''; cls?: string } = {}) {
  const m = money(zat);
  const sign = opts.sign ?? '';
  // The unit is set smaller, so big amounts stay on one line.
  const cut = m.main.lastIndexOf(' ');
  return h(
    'span',
    { class: `money ${opts.cls ?? ''}` },
    h('span', { class: 'm-main' }, `${sign}${m.main.slice(0, cut)}`, h('span', { class: 'm-unit' }, m.main.slice(cut))),
    h('span', { class: 'm-sub' }, `${sign}${m.sub}`),
  );
}

/**
 * The amount field, in ZEC or zats (Settings), the other unit underneath. With `max` (the
 * balance): "Balance … · Max", and amounts above it are refused here, before any request.
 */
export function amountEntry(opts: { label?: string; max?: () => number; optional?: boolean; autofocus?: boolean } = {}) {
  const unit = inputUnit();
  const input = h('input', {
    type: 'text',
    inputmode: unit === 'ZEC' ? 'decimal' : 'numeric',
    autocomplete: 'off',
    class: 'input mono amount-input',
    placeholder: unit === 'ZEC' ? '0.00' : '0',
    enterkeyhint: 'go',
    id: `f${++uid}`,
    'aria-label': opts.label ?? 'Amount',
  });
  // After the page has drawn (and focused its title): the amount is the first thing to do here.
  if (opts.autofocus) setTimeout(() => input.isConnected && input.focus({ preventScroll: true }), 0);
  const other = h('p', { class: 'amount-other mono', 'aria-live': 'polite' });
  const err = h('p', { class: 'field-err', role: 'alert' });
  const balance = opts.max ? h('span', { class: 'hint' }) : null;
  const maxBtn = opts.max ? h('button', { type: 'button', class: 'link-btn' }, 'Max') : null;
  let touched = false;

  /** zats, null for none; throws a plain message. */
  const read = (): number | null => {
    const zat = parseAmount(input.value, unit);
    if (zat !== null && opts.max && zat > opts.max()) throw new Error(`That’s more than you have (${moneyText(opts.max())}).`);
    return zat;
  };
  const update = () => {
    if (balance) balance.textContent = `Balance ${moneyText(opts.max!())}`;
    try {
      const zat = read();
      other.textContent = zat === null ? '' : `= ${unit === 'ZEC' ? zatsText(zat) : zecText(zat)}`;
      err.textContent = '';
      input.removeAttribute('aria-invalid');
    } catch (e) {
      other.textContent = '';
      if (touched) {
        err.textContent = (e as Error).message;
        input.setAttribute('aria-invalid', 'true');
      }
    }
  };
  input.addEventListener('input', () => {
    touched = true;
    update();
  });
  if (maxBtn) maxBtn.onclick = () => set(opts.max!());
  const set = (zat: number) => {
    input.value = amountForInput(zat, unit);
    touched = true;
    update();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  update();
  input.setAttribute('aria-describedby', `${input.id}-other`);
  other.id = `${input.id}-other`;
  const el = h(
    'div',
    { class: 'amount-entry' },
    h('div', { class: 'amount-wrap' }, input, h('span', { class: 'suffix', 'aria-hidden': 'true' }, unit)),
    other,
    balance ? h('div', { class: 'amount-balance' }, balance, maxBtn) : null,
    err,
  );
  return {
    el,
    input,
    set,
    refresh: update,
    /** The amount in zats, or throws (and shows) a plain message. `optional`: '' is null. */
    zat(): number | null {
      touched = true;
      try {
        const zat = read();
        if (zat === null && !opts.optional) throw new Error('Enter an amount.');
        err.textContent = '';
        return zat;
      } catch (e) {
        err.textContent = (e as Error).message;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        throw e;
      }
    },
  };
}

/** A tappable history row. */
export function feedRow(item: FeedItem) {
  const icon = { deposit: ICON.deposit, withdraw: ICON.withdraw, send: ICON.send, receive: ICON.receive, request: ICON.receive }[item.kind];
  return h(
    'a',
    { href: `#${item.href}`, class: `feed-row ${item.pending ? 'pending' : ''}` },
    h('span', { class: `feed-icon k-${item.kind}` }, svg(icon)),
    h('span', { class: 'feed-main' }, h('span', { class: 'feed-title' }, item.title), h('span', { class: `feed-status t-${item.tone}` }, item.pending ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null, item.of ? `of ${moneyText(item.of)} · ` : '', item.status, ' · ', ago(item.at))),
    moneyEl(Math.abs(item.amount), { sign: item.amount >= 0 ? '+' : '−', cls: `feed-amt ${item.amount >= 0 ? 'in' : 'out'}` }),
  );
}

/** ▮▮▮▯▯▯▯▯▯▯ */
export function segmentBar(filled: number, label: string, n = 10) {
  return h(
    'div',
    { class: 'segbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(filled), 'aria-label': label },
    Array.from({ length: n }, (_, i) => h('span', { class: i < filled ? 'on' : '' })),
  );
}

/** A status line with a blinking block cursor while something is waiting. */
export function waiting(text: string) {
  // The cursor is glued to the last word, so it never wraps onto a line of its own.
  const cut = text.lastIndexOf(' ');
  const head = cut < 0 ? '' : text.slice(0, cut + 1);
  const last = cut < 0 ? text : text.slice(cut + 1);
  return h('span', { class: 'waiting' }, head, h('span', { class: 'nowrap' }, last, h('span', { class: 'cursor', 'aria-hidden': 'true' })));
}

/** A success word that glitches once (static under prefers-reduced-motion). */
export function glitch(text: string, cls = '') {
  return h('span', { class: `glitch ${cls}`, 'data-text': text }, text);
}

export function emptyState(text: string, action?: HTMLElement) {
  return h('div', { class: 'empty' }, h('p', null, text), action ?? null);
}

/** Technical words live here, folded away. */
export function details(...kids: Array<Node | string | null | false>) {
  return h('details', { class: 'details' }, h('summary', null, 'Details'), h('div', { class: 'details-body' }, ...kids.filter((k): k is Node | string => !!k)));
}

/** k: v row for Details sections and reviews. */
export const kv = (k: string, v: Node | string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), typeof v === 'string' ? h('span', { class: 'mono' }, v) : v);

/**
 * The big ending of every action: a mark, a word ("Received"), the amount, one line of what it
 * means or what to do next, and the next step (Done goes home).
 */
export function resultView(opts: {
  ok: boolean;
  title: string;
  zat?: number;
  sign?: '+' | '−' | '';
  text?: string | Node;
  actions?: HTMLElement[];
  done?: boolean;
  extra?: Node | null;
}) {
  const done = opts.done === false ? null : h('a', { href: '#/', class: `btn block ${opts.actions?.length ? 'ghost' : 'primary'}` }, 'Done');
  return h(
    'section',
    { class: `result ${opts.ok ? 'ok' : 'bad'}`, role: opts.ok ? 'status' : 'alert' },
    h('span', { class: 'result-mark', 'aria-hidden': 'true' }, svg(opts.ok ? ICON.check : ICON.alert)),
    h('h2', { class: 'result-title' }, opts.ok ? glitch(opts.title) : opts.title),
    opts.zat !== undefined ? moneyEl(opts.zat, { sign: opts.sign ?? '', cls: 'result-money' }) : null,
    opts.text ? h('p', { class: 'result-text' }, opts.text) : null,
    opts.extra ?? null,
    h('div', { class: 'result-actions' }, ...(opts.actions ?? []), done),
  );
}
