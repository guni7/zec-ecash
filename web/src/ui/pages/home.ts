import { fetchReserves, type Reserves } from '../../wallet/status';
import { h, svg, ICON } from '../dom';
import { backupNudge } from '../flows';
import { feedRow, moneyEl, pageHead, type Page } from '../widgets';
import { moneyText } from '../words';

/** The last reserve check, shared by Home's chip (refreshed at most every 30 s). */
let reserves: { at: number; r: Reserves | null } = { at: 0, r: null };
export async function latestReserves(maxAgeMs = 30_000): Promise<Reserves | null> {
  if (Date.now() - reserves.at > maxAgeMs) {
    try {
      reserves = { at: Date.now(), r: await fetchReserves() };
    } catch {
      reserves = { at: Date.now(), r: null };
    }
  }
  return reserves.r;
}

/** "Backed 104% · 3/3 keyholders", or what's wrong. */
export function backingChip(r: Reserves | null) {
  if (!r) return { text: 'Checking the backing…', tone: 'muted' };
  const up = r.guardians.filter((g) => g.up && g.key_ok).length;
  const keys = `${up}/${r.guardians.length || 3} keyholders`;
  if (r.state === 'violated') return { text: `Backing problem · ${keys}`, tone: 'bad' };
  if (r.state === 'unknown') return { text: `Checking the backing… · ${keys}`, tone: 'muted' };
  return { text: `Backed ${backedPct(r)}% · ${keys}`, tone: up >= 2 ? 'ok' : 'warn' };
}

/** ZEC held per ZEC owed, as a whole percentage, rounded down (99.9% never reads 100%). */
export const backedPct = (r: Reserves) => ((r.required_zats ?? 0) > 0 ? Math.floor(((r.reserve_zats ?? 0) / r.required_zats!) * 100) : 100);

export const home: Page = {
  title: 'Home',
  render(app) {
    const card = h('section', { class: 'balance-card', 'aria-label': 'Balance' });
    const actions = h('div', { class: 'home-actions' });
    const nudge = h('div');
    const recent = h('div');
    const chip = h('a', { href: '#/status', class: 'backing-chip t-muted' }, svg(ICON.shield), h('span', null, 'Checking the backing…'));

    const update = () => {
      const bal = app.core.balance();
      const notes: HTMLElement[] = [];
      const offline = app.tokens.pendingOfflineZat();
      if (offline) notes.push(h('span', { class: 't-live' }, `+${moneyText(offline)} received offline, confirmed when you’re back online`));
      const held = app.onchain.withdrawals().filter((w) => w.state === 'sending' || w.state === 'pending');
      if (held.length) notes.push(h('a', { href: held.length === 1 ? `#/withdraw?q=${encodeURIComponent(held[0].quote)}` : '#/activity', class: 't-live' }, held.length === 1 ? 'Cashing out…' : `${held.length} cash-outs in progress`));
      const open = app.onchain.deposits().filter((d) => d.state === 'unpaid' || d.state === 'paid');
      if (open.length) notes.push(h('a', { href: open.length === 1 ? `#/deposit?q=${encodeURIComponent(open[0].quote)}` : '#/activity', class: 't-live' }, open.length === 1 ? 'Adding money: waiting for your payment' : `${open.length} add-money payments open`));
      card.replaceChildren(h('span', { class: 'balance-label' }, 'Balance'), moneyEl(bal, { cls: 'balance' }), notes.length ? h('div', { class: 'balance-extra' }, notes) : '');

      const items = app.feed();
      const empty = bal === 0 && !items.length && !offline;
      actions.replaceChildren(
        ...(empty
          ? [h('div', { class: 'empty start' }, h('p', null, 'Add money to get started'), h('a', { href: '#/deposit', class: 'btn primary block big' }, svg(ICON.deposit), 'Add money'))]
          : [
              h('a', { href: '#/deposit', class: 'btn primary big' }, svg(ICON.deposit), 'Add money'),
              h('a', { href: '#/withdraw', class: 'btn big' }, svg(ICON.withdraw), 'Cash out'),
            ]),
      );
      actions.classList.toggle('single', empty);
      nudge.replaceChildren(empty ? '' : (backupNudge(app, update) ?? ''));
      recent.replaceChildren(
        items.length
          ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Recent'), h('a', { href: '#/activity', class: 'link' }, 'All →')), h('div', { class: 'feed' }, items.slice(0, 5).map(feedRow)))
          : '',
      );
    };
    update();

    const drawChip = async () => {
      const c = backingChip(await latestReserves());
      chip.className = `backing-chip t-${c.tone}`;
      chip.lastElementChild!.textContent = c.text;
    };
    void drawChip();
    const timer = setInterval(() => void drawChip(), 30_000);

    const gear = h('a', { href: '#/settings', class: 'icon-btn', 'aria-label': 'Settings' }, svg(ICON.settings));
    const el = h(
      'div',
      { class: 'page home' },
      pageHead('Home', { hidden: true, right: h('div', { class: 'home-top' }, h('span', { class: 'brand small', 'aria-hidden': 'true' }, h('span', { class: 'brand-mark' }, 'ZEC'), h('span', { class: 'brand-slash' }, '/'), h('span', null, 'ecash')), gear) }),
      card,
      chip,
      actions,
      // Shop mode keeps the shop in the tab bar; the wallet's own pages are one tap away here.
      app.prefs.get().shopMode
        ? h('nav', { class: 'wallet-links', 'aria-label': 'Wallet' }, ([['#/send', 'Send', ICON.send], ['#/scan', 'Scan', ICON.scan], ['#/receive', 'Receive', ICON.receive], ['#/activity', 'Activity', ICON.activity]] as const).map(([href, label, icon]) => h('a', { href, class: 'btn' }, svg(icon), label)))
        : '',
      nudge,
      recent,
    );
    const off = app.onChange(update);
    return {
      el,
      cleanup: () => {
        off();
        clearInterval(timer);
      },
    };
  },
};
