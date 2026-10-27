// Cash out: a withdrawal (onchain.ts) in plain words.
import { explorer, normalizePaymentText, parsePaymentUri, zatToZec, type QuotedWithdrawal, type Withdrawal } from '../../wallet/onchain';
import { busy, copyChip, h, svg, ICON } from '../dom';
import { takeHandoff } from '../handoff';
import { go } from '../router';
import { scanQr } from '../scanner';
import { amountEntry, details, kv, moneyEl, pageHead, resultView, waiting, type App, type Page } from '../widgets';
import { moneyText } from '../words';

export const withdraw: Page = {
  title: 'Cash out',
  render(app, route) {
    const q = route.params.get('q');
    const w = q ? app.onchain.withdrawals().find((x) => x.quote === q) : undefined;
    return w ? detail(app, w) : form(app);
  },
};

function limitText(app: App) {
  const l = app.onchain.limits().melt;
  if (l.min && l.max) return `Between ${moneyText(l.min)} and ${moneyText(l.max)}, plus a network fee.`;
  if (l.max) return `Up to ${moneyText(l.max)}, plus a network fee.`;
  return l.min ? `At least ${moneyText(l.min)}, plus a network fee.` : 'Plus a small network fee.';
}

function form(app: App) {
  const address = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: 'u1… or a zcash: payment link' });
  const amount = amountEntry({ max: () => app.core.balance() });
  const scanBtn = h('button', { type: 'button', class: 'btn' }, svg(ICON.scan), 'Scan');
  const quoteBtn = h('button', { type: 'submit', class: 'btn primary block big' }, 'Review');
  const uriNote = h('p', { class: 'hint' });
  const review = h('div', { class: 'review', hidden: true });
  const hint = h('p', { class: 'hint' }, limitText(app));
  const addrErr = h('p', { class: 'field-err', role: 'alert' });

  /** A zcash: payment link fills in the amount. */
  const readUri = () => {
    addrErr.textContent = '';
    try {
      const u = parsePaymentUri(address.value);
      if (u.amount !== undefined) amount.set(u.amount);
      uriNote.textContent = /^zcash:/i.test(address.value.trim()) ? `Payment link${u.amount !== undefined ? ` for ${moneyText(u.amount)}` : ''}${u.note ? ` · ${app.explain(new Error(u.note))}` : ''}` : '';
    } catch (e) {
      uriNote.textContent = '';
      addrErr.textContent = app.explain(e);
    }
  };
  const invalidate = () => {
    app.onchain.cancelQuote();
    review.hidden = true;
    quoteBtn.hidden = false;
  };
  address.addEventListener('input', () => {
    invalidate();
    readUri();
  });
  amount.input.addEventListener('input', invalidate);
  amount.input.addEventListener('change', invalidate);
  scanBtn.onclick = async () => {
    const r = await scanQr('Point the camera at their Zcash address');
    if (r && 'text' in r) {
      address.value = normalizePaymentText(r.text);
      invalidate();
      readUri();
    } else if (r && 'error' in r) {
      addrErr.textContent = r.error;
      address.focus();
    } else if (r) address.focus();
  };
  const handed = takeHandoff('/withdraw');
  if (handed) {
    address.value = normalizePaymentText(handed);
    readUri();
  }

  const showReview = (q: QuotedWithdrawal) => {
    const balance = app.core.balance();
    const short = balance < q.total;
    const ack = h('input', { type: 'checkbox', class: 'ack-box', id: 'wd-ack' });
    const confirmBtn = h('button', { type: 'button', class: `btn block confirm ${app.core.mainnet ? 'danger' : 'primary'}`, disabled: short || app.core.mainnet }, app.core.mainnet ? 'Send real ZEC' : 'Cash out');
    ack.onchange = () => (confirmBtn.disabled = short || !ack.checked);
    confirmBtn.onclick = () =>
      void busy(
        confirmBtn,
        async () => {
          const w = await app.onchain.confirmWithdrawal(ack.checked);
          if (w) go(`/withdraw?q=${encodeURIComponent(w.quote)}`, true);
        },
        app.explain,
      );
    review.replaceChildren(
      h('p', { class: 'confirm-label' }, 'Check and confirm'),
      kv('To', copyChip(q.address, 'Address', 8, 6)),
      kv('Amount', moneyText(q.amount)),
      kv('Network fee, at most', moneyText(q.fee)),
      kv('Total', moneyText(q.total), 'total'),
      h('p', { class: 'hint' }, `Any unused fee comes back to your wallet.${q.note ? ` ${app.explain(new Error(q.note))}` : ''}`),
      short ? h('p', { class: 'field-err' }, `Not enough money: you have ${moneyText(balance)}.`) : '',
      app.core.mainnet
        ? h(
            'div',
            { class: 'mainnet-confirm', role: 'alert' },
            h('strong', null, '⚠ MAINNET · REAL ZEC'),
            h('p', null, `This sends ${zatToZec(q.amount)} real ZEC to the address above. A blockchain payment can't be reversed: check the address.`),
            h('label', { class: 'ack', for: 'wd-ack' }, ack, h('span', null, "I've checked the address. Send real ZEC.")),
          )
        : h('p', { class: 'warn-line' }, 'A Zcash payment can’t be reversed: check the address.'),
      h('div', { class: 'thumb row' }, h('button', { type: 'button', class: 'btn', onclick: invalidate }, 'Cancel'), confirmBtn),
    );
    review.hidden = false;
    quoteBtn.hidden = true;
    review.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const el = h(
    'div',
    { class: 'page' },
    pageHead('Cash out', { back: true }),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          if (!address.value.trim()) {
            addrErr.textContent = 'Enter or scan the Zcash address to send to.';
            return address.focus();
          }
          let zat: number | null;
          try {
            zat = amount.zat();
          } catch {
            return;
          }
          void busy(quoteBtn, async () => showReview(await app.onchain.quoteWithdrawal(address.value, String(zat))), app.explain);
        },
      },
      h('div', { class: 'field' }, h('div', { class: 'label-row' }, h('label', { for: 'wd-addr' }, 'To'), scanBtn), address, uriNote, addrErr),
      h('div', { class: 'field' }, h('label', { for: amount.input.id }, 'Amount'), amount.el),
      hint,
      h('div', { class: 'thumb' }, quoteBtn),
    ),
    review,
  );
  address.id = 'wd-addr';
  return { el, cleanup: app.onChange(() => (hint.textContent = limitText(app))) };
}

function detail(app: App, w0: Withdrawal) {
  const body = h('div', { class: 'flow' });
  let shown = '';
  const render = () => {
    const w = app.onchain.withdrawals().find((x) => x.quote === w0.quote) ?? w0;
    if (w.state === shown) return;
    shown = w.state;
    const facts = [kv('To', copyChip(w.address, 'Address', 8, 6)), kv('Amount', moneyText(w.amount))];
    if (w.state === 'paid') {
      facts.push(kv('Network fee', moneyText(w.fee ?? 0)), kv('Change returned', moneyText(w.change ?? 0)));
      if (w.txid) facts.push(kv('Transaction', copyChip(w.txid, 'Transaction id', 8, 6)));
      body.replaceChildren(
        resultView({
          ok: true,
          title: 'Sent',
          zat: w.amount,
          sign: '−',
          text: w.note ? app.explain(new Error(w.note)) : 'It’s on its way to the address.',
          actions: w.txid && app.core.mainnet ? [h('a', { href: explorer(w.txid), target: '_blank', rel: 'noopener noreferrer', class: 'btn block' }, 'View on the blockchain ', h('span', { html: ICON.external }))] : [],
        }),
        details(...facts, app.core.mainnet ? null : h('p', { class: 'hint' }, 'Regtest devnet: no public explorer for this transaction.'), h('p', { class: 'hint mono' }, `quote ${w.quote}`)),
      );
    } else if (w.state === 'returned') {
      body.replaceChildren(
        resultView({ ok: false, title: 'Not sent', zat: w.amount, text: `${w.note ? `${app.explain(new Error(w.note))} ` : ''}The money is back in your wallet.`, actions: [h('a', { href: '#/withdraw', class: 'btn primary block' }, 'Try again')] }),
        details(...facts, h('p', { class: 'hint mono' }, `quote ${w.quote}`)),
      );
    } else {
      body.replaceChildren(
        moneyEl(w.amount, { cls: 'code-money' }),
        h('div', { class: 'status-line' }, waiting('Sending…')),
        h('ol', { class: 'steps' }, h('li', { class: 'done' }, 'Money handed over'), h('li', { class: w.state === 'pending' ? 'now' : '' }, 'Keyholders approve (2 of 3) and send it'), h('li', null, 'Confirmed on the Zcash network')),
        h('p', { class: 'hint' }, 'Safe to close: it finishes by itself.'),
        details(...facts, kv('Held for it', moneyText(w.amount + w.feeReserve)), h('p', { class: 'hint' }, 'A NUT-05 melt: the ecash is handed to the mint, its guardians co-sign the Zcash transaction (FROST, 2 of 3), and unused fee comes back as change (NUT-08).'), h('p', { class: 'hint mono' }, `quote ${w.quote}`)),
      );
    }
  };
  render();
  void app.onchain.tick();
  const off = app.onChange(render);
  return { el: h('div', { class: 'page' }, pageHead('Cash out', { back: true }), body), cleanup: () => off() };
}
