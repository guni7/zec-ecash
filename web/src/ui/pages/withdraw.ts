import { explorer, parsePaymentUri, zatToZec, type QuotedWithdrawal, type Withdrawal } from '../../wallet/onchain';
import { ago, busy, copyChip, fmtZat, fmtZec, h, svg, ICON } from '../dom';
import { go } from '../router';
import { scanQr } from '../scanner';
import { amountField, amountInput, emptyState, field, glitch, pageHead, waiting, type App, type Page } from '../widgets';

export const withdraw: Page = {
  title: 'Withdraw',
  render(app, route) {
    const q = route.params.get('q');
    const w = q ? app.onchain.withdrawals().find((x) => x.quote === q) : undefined;
    return w ? detail(app, w) : form(app);
  },
};

function limitText(app: App) {
  const l = app.onchain.limits().melt;
  return l.min || l.max ? `Min ${fmtZat(l.min ?? 1)} · max ${l.max ? fmtZat(l.max) : '∞'} zat, plus the network fee.` : '';
}

function form(app: App) {
  const address = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', placeholder: 'u1… or zcash:u1…?amount=0.001' });
  const amount = amountInput();
  const scanBtn = h('button', { type: 'button', class: 'btn' }, svg(ICON.scan), 'Scan');
  const quoteBtn = h('button', { type: 'submit', class: 'btn primary block' }, '[ GET QUOTE ]');
  const uriNote = h('p', { class: 'hint' });
  const review = h('div', { class: 'review', hidden: true });
  const hint = h('p', { class: 'hint' }, limitText(app));

  /** A pasted ZIP-321 URI fills in the amount. */
  const readUri = () => {
    try {
      const u = parsePaymentUri(address.value);
      if (u.amount !== undefined) {
        amount.value = String(u.amount);
        amount.dispatchEvent(new Event('input'));
      }
      uriNote.textContent = /^zcash:/i.test(address.value.trim()) ? `Payment URI: ${u.amount !== undefined ? `${fmtZat(u.amount)} zat to ` : ''}${u.address.slice(0, 10)}…${u.note ? ` · ${u.note}` : ''}` : '';
    } catch (e) {
      uriNote.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  const invalidate = () => {
    app.onchain.cancelQuote();
    review.hidden = true;
  };
  address.addEventListener('input', () => {
    invalidate();
    readUri();
  });
  amount.addEventListener('input', invalidate);
  scanBtn.onclick = async () => {
    const got = await scanQr('Point the camera at a Zcash address or payment QR code');
    if (got) {
      address.value = got.trim();
      invalidate();
      readUri();
    }
  };

  const showReview = (q: QuotedWithdrawal) => {
    const balance = app.core.balance();
    const short = balance < q.total;
    const ack = h('input', { type: 'checkbox', class: 'ack-box', id: 'wd-ack' });
    const confirmBtn = h('button', { type: 'button', class: `btn block confirm ${app.core.mainnet ? 'danger' : 'primary'}`, disabled: short || app.core.mainnet }, app.core.mainnet ? 'Send real ZEC' : '[ SEND ZEC ]');
    ack.onchange = () => (confirmBtn.disabled = short || !ack.checked);
    confirmBtn.onclick = () =>
      void busy(
        confirmBtn,
        async () => {
          const w = await app.onchain.confirmWithdrawal(ack.checked);
          if (w) go(`/withdraw?q=${encodeURIComponent(w.quote)}`, true);
        },
        app.core.explain,
      );
    const r = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('span', { class: 'mono' }, v));
    review.replaceChildren(
      h('span', { class: 'tag' }, '[ REVIEW ]'),
      h('div', { class: 'kv' }, h('span', null, 'To'), copyChip(q.address, 'Address', 8, 6)),
      r('Amount', `${fmtZat(q.amount)} zat`),
      r('Network fee, at most', `${fmtZat(q.fee)} zat`),
      r('Total ecash used', `${fmtZat(q.total)} zat`, 'total'),
      r('Balance after (at least)', `${fmtZat(Math.max(0, balance - q.total))} zat`),
      h('p', { class: 'hint' }, `${fmtZec(q.amount)} arrives on chain. Unused fee comes back as change.${q.note ? ` ${q.note}` : ''}`),
      short ? h('p', { class: 't-bad' }, `Not enough ecash: balance is ${fmtZat(balance)} zat.`) : '',
      app.core.mainnet
        ? h(
            'div',
            { class: 'mainnet-confirm', role: 'alert' },
            h('strong', null, '⚠ MAINNET · REAL ZEC'),
            h('p', null, `This sends ${zatToZec(q.amount)} real ZEC to the address above. A blockchain payment can't be reversed: check the address.`),
            h('label', { class: 'ack', for: 'wd-ack' }, ack, h('span', null, "I've checked the address. Send real ZEC.")),
          )
        : '',
      h('div', { class: 'thumb row' }, h('button', { type: 'button', class: 'btn', onclick: invalidate }, 'Cancel'), confirmBtn),
    );
    review.hidden = false;
    review.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const recent = app.onchain.withdrawals();
  const el = h(
    'div',
    { class: 'page' },
    pageHead('WITHDRAW', 'Withdraw ZEC', 'Turn ecash back into ZEC at any Zcash address.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: SubmitEvent) => {
          e.preventDefault();
          void busy(quoteBtn, async () => showReview(await app.onchain.quoteWithdrawal(address.value, amount.value)), app.core.explain);
        },
      },
      field('Address or payment URI', address),
      h('div', { class: 'row' }, scanBtn),
      uriNote,
      amountField('Amount', amount),
      hint,
      h('div', { class: 'thumb' }, quoteBtn),
    ),
    review,
    h(
      'section',
      { class: 'section' },
      h('h3', { class: 'section-title' }, 'Recent'),
      recent.length
        ? h(
            'div',
            { class: 'list' },
            recent.slice(0, 6).map((w) =>
              h('a', { href: `#/withdraw?q=${encodeURIComponent(w.quote)}`, class: 'list-row' }, h('span', { class: 'mono' }, `${fmtZat(w.amount)} zat`), h('span', { class: `hint t-${w.state === 'paid' ? 'ok' : w.state === 'returned' ? 'bad' : 'live'}` }, `${w.state} · ${ago(w.created)}`)),
            ),
          )
        : emptyState('No withdrawals yet.'),
    ),
  );
  return { el, cleanup: app.onChange(() => (hint.textContent = limitText(app))) };
}

function detail(app: App, w0: Withdrawal) {
  const state = h('div', { class: 'status-line big' });
  const body = h('div', { class: 'stack' });
  let shown = '';
  const render = () => {
    const w = app.onchain.withdrawals().find((x) => x.quote === w0.quote) ?? w0;
    if (w.state === shown) return;
    shown = w.state;
    state.replaceChildren(
      w.state === 'sending'
        ? waiting('SENDING')
        : w.state === 'pending'
          ? waiting('PENDING')
          : w.state === 'paid'
            ? glitch('PAID', 't-live')
            : h('span', { class: 't-bad' }, 'NOT SENT'),
    );
    const kv = (k: string, v: Node | string) => h('div', { class: 'kv' }, h('span', null, k), typeof v === 'string' ? h('span', { class: 'mono' }, v) : v);
    const rows: Node[] = [kv('To', copyChip(w.address, 'Address', 8, 6)), kv('Amount', `${fmtZat(w.amount)} zat`)];
    if (w.state === 'paid') {
      rows.push(kv('Network fee', `${fmtZat(w.fee ?? 0)} zat`), kv('Change returned', `${fmtZat(w.change ?? 0)} zat`));
      if (w.txid) {
        rows.push(kv('Transaction', copyChip(w.txid, 'Transaction id', 8, 6)));
        rows.push(
          app.core.mainnet
            ? h('a', { href: explorer(w.txid), target: '_blank', rel: 'noopener noreferrer', class: 'btn block' }, 'View in explorer ', h('span', { html: ICON.external }))
            : h('p', { class: 'hint' }, 'Regtest devnet: no public explorer for this transaction.'),
        );
      }
      if (w.note) rows.push(h('p', { class: 't-bad' }, w.note));
    } else if (w.state === 'returned') {
      rows.push(h('p', { class: 't-bad' }, w.note ?? 'The withdrawal failed.'), h('p', { class: 'hint' }, 'The ecash it held is back in your balance.'));
    } else {
      rows.push(
        kv('Held for it', `${fmtZat(w.amount + w.feeReserve)} zat`),
        h('ol', { class: 'steps' }, h('li', { class: 'done' }, 'Ecash handed to the mint'), h('li', { class: w.state === 'pending' ? 'now' : '' }, 'Guardians sign (2 of 3), transaction broadcast'), h('li', null, 'Mined and confirmed; change comes back')),
        h('p', { class: 'hint' }, 'Safe to close or reload: it is saved here and resumes by itself.'),
      );
    }
    body.replaceChildren(...rows);
  };
  render();
  void app.onchain.tick();
  const off = app.onChange(render);
  const el = h(
    'div',
    { class: 'page' },
    pageHead('WITHDRAW', `${fmtZat(w0.amount)} zat`, fmtZec(w0.amount)),
    state,
    body,
    h('p', { class: 'hint center mono' }, `quote ${w0.quote}`),
    h('a', { href: '#/withdraw', class: 'btn block ghost' }, 'New withdrawal'),
  );
  return { el, cleanup: () => off() };
}
