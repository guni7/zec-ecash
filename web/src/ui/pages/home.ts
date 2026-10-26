import { fmtZat, fmtZec, h, svg, ICON } from '../dom';
import { emptyState, feedRow, type Page } from '../widgets';

export const home: Page = {
  title: 'Wallet',
  render(app) {
    const amount = h('span', { class: 'balance-amount' });
    const zec = h('div', { class: 'balance-zec mono' });
    const extra = h('div', { class: 'balance-extra' });
    const recent = h('div', { class: 'feed' });

    const update = () => {
      const bal = app.core.balance();
      amount.textContent = fmtZat(bal);
      zec.textContent = fmtZec(bal);
      const notes: HTMLElement[] = [];
      const offline = app.tokens.pendingOfflineZat();
      if (offline) notes.push(h('span', { class: 't-live' }, `+${fmtZat(offline)} zat accepted offline, redeems when online`));
      const held = app.onchain.withdrawals().filter((w) => w.state === 'sending' || w.state === 'pending');
      if (held.length) notes.push(h('a', { href: '#/activity', class: 't-live' }, `${held.length} withdrawal${held.length > 1 ? 's' : ''} in progress`));
      const open = app.onchain.deposits().filter((d) => d.state === 'unpaid' || d.state === 'paid');
      if (open.length) notes.push(h('a', { href: open.length === 1 ? `#/deposit?q=${encodeURIComponent(open[0].quote)}` : '#/deposit', class: 't-live' }, `${open.length} deposit${open.length > 1 ? 's' : ''} open`));
      extra.replaceChildren(...notes);
      const items = app.feed().slice(0, 5);
      recent.replaceChildren(...(items.length ? items.map(feedRow) : [emptyState('Nothing yet. Deposit ZEC or receive a token to start.')]));
    };
    update();

    const action = (href: string, label: string, icon: string, primary = false) =>
      h('a', { href, class: `action ${primary ? 'primary' : ''}` }, svg(icon), h('span', null, label));

    const el = h(
      'div',
      { class: 'page home' },
      h(
        'section',
        { class: 'balance-card', 'aria-labelledby': 'bal-label' },
        h('span', { class: 'tag', id: 'bal-label' }, '[ BALANCE ]'),
        h('div', { class: 'balance-line' }, amount, h('span', { class: 'balance-unit' }, 'zat')),
        zec,
        extra,
      ),
      h(
        'nav',
        { class: 'actions', 'aria-label': 'Actions' },
        action('#/receive', 'Receive', ICON.receive),
        action('#/send', 'Send', ICON.send),
        action('#/deposit', 'Deposit', ICON.deposit, true),
        action('#/withdraw', 'Withdraw', ICON.withdraw),
      ),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Recent'), h('a', { href: '#/activity', class: 'link' }, 'All activity →')), recent),
    );
    return { el, cleanup: app.onChange(update) };
  },
};
