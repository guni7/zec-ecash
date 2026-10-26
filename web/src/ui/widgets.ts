// Pieces shared by the pages, and the App every page receives.
import type { FeedItem } from '../wallet/activity';
import type { Core } from '../wallet/core';
import type { Tokens } from '../wallet/tokens';
import type { PosRequests } from '../wallet/posreq';
import type { initOnchain } from '../wallet/onchain';
import { ago, fmtZat, fmtZec, h, svg, ICON } from './dom';
import type { Route } from './router';

export type Onchain = ReturnType<typeof initOnchain>;

export type App = {
  core: Core;
  tokens: Tokens;
  onchain: Onchain;
  posreq: PosRequests;
  feed(): FeedItem[];
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

export function amountInput(placeholder = '0') {
  return h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', class: 'input mono amount-input', placeholder, enterkeyhint: 'go' });
}

/** Amount input with a "zat" suffix and a live ZEC equivalent below it. */
export function amountField(label: string, input: HTMLInputElement, hint?: string) {
  const zec = h('span', { class: 'zec-eq mono', 'aria-live': 'polite' });
  const update = () => {
    const n = Number(input.value.replace(/[^0-9]/g, ''));
    zec.textContent = n > 0 ? `= ${fmtZec(n)}` : '';
  };
  input.addEventListener('input', () => {
    const clean = input.value.replace(/[^0-9]/g, '');
    if (clean !== input.value) input.value = clean;
    update();
  });
  input.id ||= `f${++uid}`;
  const hintEl = hint ? h('p', { class: 'hint', id: `${input.id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), h('div', { class: 'amount-wrap' }, input, h('span', { class: 'suffix', 'aria-hidden': 'true' }, 'zat')), zec, hintEl);
}

/** A tappable history row. */
export function feedRow(item: FeedItem) {
  const sign = item.amount >= 0 ? '+' : '−';
  const icon = { deposit: ICON.deposit, withdraw: ICON.withdraw, send: ICON.send, receive: ICON.receive, request: ICON.request }[item.kind];
  return h(
    'a',
    { href: `#${item.href}`, class: `feed-row ${item.pending ? 'pending' : ''}` },
    h('span', { class: `feed-icon k-${item.kind}` }, svg(icon)),
    h('span', { class: 'feed-main' }, h('span', { class: 'feed-title' }, item.title), h('span', { class: `feed-status t-${item.tone}` }, item.pending ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null, item.status, ' · ', ago(item.at))),
    h('span', { class: `feed-amt mono ${item.amount >= 0 ? 'in' : 'out'}` }, `${sign}${fmtZat(Math.abs(item.amount))}`),
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

/** A status word with a blinking block cursor while something is waiting. */
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

export function pageHead(tagText: string, title: string, lead?: string) {
  return h('div', { class: 'page-head' }, h('span', { class: 'tag' }, `[ ${tagText} ]`), h('h2', { class: 'page-title', tabindex: '-1' }, title), lead ? h('p', { class: 'lead' }, lead) : null);
}
