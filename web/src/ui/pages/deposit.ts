// Add money: a deposit (onchain.ts) in plain words.
import { zip321, type Deposit } from '../../wallet/onchain';
import { depositProgress, filledSegments, type DepositProgress } from '../../wallet/status';
import { ago, busy, copyChip, copyText, countdown, h, plural, svg, ICON } from '../dom';
import { backupNudge } from '../flows';
import { qrCard } from '../qr';
import { go } from '../router';
import { amountEntry, details, kv, moneyEl, pageHead, resultView, segmentBar, waiting, type App, type Page } from '../widgets';
import { moneyText } from '../words';

export const deposit: Page = {
  title: 'Add money',
  render(app, route) {
    const q = route.params.get('q');
    const d = q ? app.onchain.deposits().find((x) => x.quote === q) : undefined;
    return d ? detail(app, d) : form(app);
  },
};

function limitText(app: App) {
  const l = app.onchain.limits().mint;
  if (l.min && l.max) return `Between ${moneyText(l.min)} and ${moneyText(l.max)}.`;
  if (l.max) return `Up to ${moneyText(l.max)}.`;
  return l.min ? `At least ${moneyText(l.min)}.` : '';
}

function form(app: App) {
  const amount = amountEntry({ autofocus: true });
  const submit = h('button', { type: 'submit', class: 'btn primary block big' }, 'Get address');
  const hint = h('p', { class: 'hint' }, limitText(app));
  const open = h('div');
  const update = () => {
    hint.textContent = limitText(app);
    const list = app.onchain.deposits().filter((d) => d.state === 'unpaid' || d.state === 'paid');
    open.replaceChildren(list.length ? h('section', { class: 'section' }, h('h2', { class: 'section-title' }, 'Waiting for your payment'), h('div', { class: 'list' }, list.map(row))) : '');
  };
  update();
  const el = h(
    'div',
    { class: 'page' },
    pageHead('Add money', { back: true }),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          let zat: number | null;
          try {
            zat = amount.zat();
          } catch {
            return;
          }
          void busy(
            submit,
            async () => {
              const d = await app.onchain.createDeposit(String(zat));
              go(`/deposit?q=${encodeURIComponent(d.quote)}`, true);
            },
            app.explain,
          );
        },
      },
      amount.el,
      hint,
      h('div', { class: 'thumb' }, submit),
    ),
    open,
  );
  return { el, cleanup: app.onChange(update) };
}

function row(d: Deposit) {
  return h(
    'a',
    { href: `#/deposit?q=${encodeURIComponent(d.quote)}`, class: 'list-row' },
    h('span', { class: 'mono' }, moneyText(d.amount)),
    h('span', { class: 'hint t-live' }, `${d.state === 'paid' ? 'adding' : 'waiting'} · ${ago(d.created)}`),
  );
}

function detail(app: App, d0: Deposit) {
  const uri = zip321(d0.address, d0.amount);
  const top = h('div', { class: 'flow' });
  const state = h('div', { class: 'status-line' });
  const bar = h('div', { class: 'progress' });
  const pay = h(
    'div',
    { class: 'pay' },
    h('p', { class: 'confirm-label' }, 'Send exactly'),
    moneyEl(d0.amount, { cls: 'code-money' }),
    qrCard(uri, { label: `QR code: pay ${moneyText(d0.amount)} to the address`, ecc: 'M' }),
    h('div', { class: 'row wrap center' }, copyChip(d0.address, 'Address'), h('button', { type: 'button', class: 'btn', onclick: () => void copyText(uri, 'Payment link') }, svg(ICON.copy), 'Copy payment link')),
  );
  const meta = h('p', { class: 'hint center' });
  /** On this screen messages never pop over the QR code: errors land here instead. */
  const msg = h('p', { class: 'inline-msg', role: 'status', 'aria-live': 'polite' });
  let progress: DepositProgress | null = null;
  let shownState = '';

  const render = () => {
    const d = app.onchain.deposits().find((x) => x.quote === d0.quote) ?? d0;
    if (d.state !== shownState) {
      shownState = d.state;
      if (d.state === 'done') {
        top.replaceChildren(resultView({ ok: true, title: 'Added', zat: d.minted ?? d.amount, sign: '+', text: d.warning, extra: backupNudge(app) }));
      } else if (d.state === 'expired') {
        top.replaceChildren(
          resultView({
            ok: false,
            title: 'Expired',
            text: 'No payment arrived in time. Don’t pay this address now; start again for a new one.',
            actions: [h('a', { href: '#/deposit', class: 'btn primary block' }, 'Start again')],
          }),
        );
      } else top.replaceChildren(pay, state, bar, meta, msg);
      if (d.state === 'unpaid') msg.setAttribute('data-toast-sink', '');
      else msg.removeAttribute('data-toast-sink');
    }
    if (d.state !== 'unpaid' && d.state !== 'paid') return;
    const need = progress?.required_confirmations ?? 0;
    const got = progress?.confirmations ?? 0;
    const seen = (progress?.received_zats ?? 0) > 0;
    state.replaceChildren(waiting(d.state === 'paid' ? 'Confirmed · adding…' : seen ? 'Payment seen · confirming…' : 'Waiting for your payment…'));
    if (seen || d.state === 'paid') {
      const filled = d.state === 'paid' ? 10 : filledSegments(got, need);
      const label = d.state === 'paid' ? 'confirmed' : `${Math.min(got, need)} of ${plural(need, 'confirmation')}`;
      bar.replaceChildren(h('div', { class: 'progress-head' }, h('span', null, 'Confirming'), h('span', { class: 'mono' }, label)), segmentBar(filled, `Confirmations: ${label}`));
      bar.hidden = false;
    } else bar.hidden = true;
    meta.textContent = d.state === 'unpaid' ? `From any Zcash wallet · pay within ${countdown(d.expiry)}` : 'Safe to close: it finishes by itself.';
  };

  const poll = async () => {
    const d = app.onchain.deposits().find((x) => x.quote === d0.quote);
    if (!d || (d.state !== 'unpaid' && d.state !== 'paid')) return;
    progress = (await depositProgress(d.quote)) ?? progress;
    render();
  };
  render();
  void poll();
  void app.onchain.tick();
  const timers = [setInterval(() => void poll(), 4000), setInterval(render, 1000)];

  const el = h(
    'div',
    { class: 'page' },
    pageHead('Add money', { back: true }),
    top,
    details(
      kv('Quote', d0.quote),
      kv('Address', copyChip(d0.address, 'Address', 8, 6)),
      h('p', { class: 'hint' }, `A NUT-04 mint quote (method zec), locked to this browser's key (NUT-20). Credited after the mint's required confirmations${app.core.mainnet ? ' (about 13 minutes)' : ''}; the ecash is minted into this browser automatically.`),
    ),
  );
  const off = app.onChange(render);
  return {
    el,
    cleanup: () => {
      timers.forEach(clearInterval);
      off();
    },
  };
}
