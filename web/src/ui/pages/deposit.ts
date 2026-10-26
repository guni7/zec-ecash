import { zip321, type Deposit } from '../../wallet/onchain';
import { depositProgress, filledSegments, type DepositProgress } from '../../wallet/status';
import { ago, busy, copyChip, copyText, countdown, fmtZat, fmtZec, h, plural, svg, ICON } from '../dom';
import { qrCard } from '../qr';
import { go } from '../router';
import { amountField, amountInput, emptyState, glitch, pageHead, segmentBar, waiting, type App, type Page } from '../widgets';

export const deposit: Page = {
  title: 'Deposit',
  render(app, route) {
    const q = route.params.get('q');
    const d = q ? app.onchain.deposits().find((x) => x.quote === q) : undefined;
    return d ? detail(app, d) : form(app);
  },
};

function limitText(app: App) {
  const l = app.onchain.limits().mint;
  return l.min || l.max ? `Min ${fmtZat(l.min ?? 1)} · max ${l.max ? fmtZat(l.max) : '∞'} zat per deposit.` : '';
}

function form(app: App) {
  const amount = amountInput();
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, '[ GET ADDRESS ]');
  const hint = h('p', { class: 'hint' }, limitText(app));
  const list = h('div');
  const update = () => {
    hint.textContent = limitText(app);
    const all = app.onchain.deposits();
    const open = all.filter((d) => d.state === 'unpaid' || d.state === 'paid');
    list.replaceChildren(
      h(
        'section',
        { class: 'section' },
        h('h3', { class: 'section-title' }, open.length ? `Open · ${open.length}` : 'Recent'),
        all.length ? h('div', { class: 'list' }, (open.length ? open : all.slice(0, 5)).map(row)) : emptyState('No deposits yet.'),
      ),
    );
  };
  update();
  const el = h(
    'div',
    { class: 'page' },
    pageHead('DEPOSIT', 'Deposit ZEC', 'Get an address for an exact amount, pay it from any Zcash wallet, and the ecash is minted here once the payment confirms.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          void busy(
            submit,
            async () => {
              const d = await app.onchain.createDeposit(amount.value);
              go(`/deposit?q=${encodeURIComponent(d.quote)}`, true);
            },
            app.core.explain,
          );
        },
      },
      amountField('Amount to deposit', amount),
      hint,
      h('div', { class: 'thumb' }, submit),
    ),
    list,
  );
  return { el, cleanup: app.onChange(update) };
}

function row(d: Deposit) {
  const st = { unpaid: 'awaiting payment', paid: 'minting', expired: 'expired', done: 'minted' }[d.state];
  return h(
    'a',
    { href: `#/deposit?q=${encodeURIComponent(d.quote)}`, class: 'list-row' },
    h('span', { class: 'mono' }, `${fmtZat(d.amount)} zat`),
    h('span', { class: `hint t-${d.state === 'done' ? 'ok' : d.state === 'expired' ? 'muted' : 'live'}` }, `${st} · ${ago(d.created)}`),
  );
}

function detail(app: App, d0: Deposit) {
  const uri = zip321(d0.address, d0.amount);
  const state = h('div', { class: 'status-line big' });
  const bar = h('div', { class: 'progress' });
  const pay = h(
    'div',
    { class: 'pay' },
    qrCard(uri, { label: `QR code: pay ${fmtZec(d0.amount)} to the deposit address`, ecc: 'M' }),
    h('div', { class: 'row wrap center' }, copyChip(d0.address, 'Address'), h('button', { type: 'button', class: 'btn', onclick: () => void copyText(uri, 'Payment URI') }, svg(ICON.copy), 'Copy payment URI')),
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
      state.replaceChildren(
        d.state === 'unpaid'
          ? waiting('AWAITING PAYMENT')
          : d.state === 'paid'
            ? waiting('CONFIRMED · MINTING')
            : d.state === 'done'
              ? h('span', null, glitch('MINTED', 't-live'), h('span', { class: 'mono minted' }, ` +${fmtZat(d.minted ?? d.amount)} zat`))
              : h('span', { class: 't-bad' }, 'EXPIRED'),
      );
      pay.hidden = d.state !== 'unpaid';
      if (d.state === 'unpaid') msg.setAttribute('data-toast-sink', '');
      else msg.removeAttribute('data-toast-sink');
    }
    const need = progress?.required_confirmations ?? 0;
    const got = progress?.confirmations ?? 0;
    const seen = (progress?.received_zats ?? 0) > 0;
    if (d.state === 'unpaid' || d.state === 'paid') {
      const filled = d.state === 'paid' ? 10 : seen ? filledSegments(got, need) : 0;
      const label = d.state === 'paid' ? 'confirmed' : !seen ? 'waiting for the payment to be mined' : `${Math.min(got, need)} / ${plural(need, 'confirmation')}`;
      bar.replaceChildren(h('div', { class: 'progress-head' }, h('span', { class: 'tag' }, '[ CONFIRMATIONS ]'), h('span', { class: 'mono' }, label)), segmentBar(filled, `Deposit confirmations: ${label}`));
      bar.hidden = false;
    } else bar.hidden = true;
    meta.textContent =
      d.state === 'unpaid'
        ? `Expires in ${countdown(d.expiry)}${need ? ` · credited after ${plural(need, 'confirmation')}${app.core.mainnet ? ' (about 13 min)' : ''}` : ''}`
        : d.state === 'expired'
          ? "Expired before a payment confirmed. Don't pay this address now."
          : d.state === 'done'
            ? `Minted ${fmtZat(d.minted ?? d.amount)} zat into this wallet.${d.warning ? ` ${d.warning}` : ''}`
            : 'The payment confirmed; the ecash is being minted (this resumes by itself after a reload).';
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
    pageHead('DEPOSIT', `${fmtZat(d0.amount)} zat`, `Pay exactly ${fmtZec(d0.amount)}`),
    pay,
    state,
    bar,
    meta,
    msg,
    h('p', { class: 'hint center mono' }, `quote ${d0.quote}`),
    h('a', { href: '#/deposit', class: 'btn block ghost' }, 'New deposit'),
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
