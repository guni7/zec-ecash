// Is my money safe? The reserve check and the keyholders (guardians), live, in plain words; the
// numbers behind it under Details.
import { fetchReserves, type Reserves } from '../../wallet/status';
import { fmtZat, h, plural, svg, ICON } from '../dom';
import { details, kv, pageHead, type Page } from '../widgets';
import { isZatsFirst, zatsText } from '../words';
import { zatToZec } from '../../wallet/onchain';
import { backedPct } from './home';

export const status: Page = {
  title: 'Is my money safe?',
  render(app) {
    const hero = h('section', { class: 'backing', 'aria-live': 'polite' });
    const keys = h('section', { class: 'card keyholders' });
    // Kept across refreshes, so an open Details stays open.
    const more = details();
    const moreBody = more.querySelector('.details-body')!;
    let last: Reserves | null = null;
    let lastAt = 0;
    let failed = false;

    const ago = (unix?: number | null) => {
      if (!unix) return 'never';
      const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
      return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
    };

    const draw = () => {
      const r = last;
      if (!r || r.state === 'unknown') {
        hero.className = 'backing muted';
        hero.replaceChildren(h('div', { class: 'backing-word' }, failed ? 'Can’t check right now' : 'Checking…'), h('p', { class: 'hint' }, failed ? 'The status service didn’t answer. Your money is safe on this device; this page tries again by itself.' : ''));
      } else {
        const held = r.reserve_zats ?? 0;
        const owed = r.required_zats ?? 0;
        const ok = r.state !== 'violated';
        const pct = backedPct(r);
        // Held and owed with the same number of decimals, so they compare at a glance.
        const places = Math.max(...[held, owed].map((z) => (zatToZec(z).split('.')[1] ?? '').length));
        const same = (z: number) => (isZatsFirst() ? zatsText(z) : `${(z / 1e8).toFixed(places)} ZEC`);
        const fill = held > 0 ? Math.min(100, (owed / held) * 100) : owed > 0 ? 100 : 0;
        hero.className = `backing ${ok ? 'ok' : 'bad'}`;
        hero.replaceChildren(
          h('div', { class: 'backing-top' }, h('span', { class: 'backing-mark', 'aria-hidden': 'true' }, svg(ok ? ICON.check : ICON.alert)), h('div', { class: 'backing-word' }, ok ? 'Fully backed' : 'Problem'), h('span', { class: 'backing-pct mono' }, `${pct}%`)),
          h('p', { class: 'backing-text' }, ok ? 'Every ZEC owed is held in the reserve.' : 'The reserve holds less ZEC than is owed. Adding money is paused until it’s fixed.'),
          h(
            'div',
            { class: 'hvo', role: 'img', 'aria-label': `Held ${same(held)}, owed ${same(owed)}` },
            h('span', { class: 'hvo-label' }, 'Held vs owed'),
            h('div', { class: 'hvo-track' }, h('div', { class: `hvo-fill ${ok ? '' : 'over'}`, style: `width:${fill}%` })),
            h('div', { class: 'hvo-legend' }, h('span', null, h('i', { class: 'sw owed' }), `Owed ${same(owed)}`), h('span', null, h('i', { class: 'sw held' }), `Held ${same(held)}`)),
          ),
          r.operator_action?.length ? h('p', { class: 't-warn' }, `${plural(r.operator_action.length, 'cash-out')} ${r.operator_action.length === 1 ? 'is' : 'are'} waiting for the operator.`) : '',
        );
      }

      const gs = r?.guardians.length ? r.guardians : [1, 2, 3].map((id) => ({ id, up: false, key_ok: false, last_seen: null }));
      const up = gs.filter((g) => g.up && g.key_ok).length;
      keys.replaceChildren(
        h('h2', { class: 'section-title' }, 'Keyholders'),
        h('p', null, 'Three independent keyholders. Any two must approve every cash-out, so no single person can take the money.'),
        h(
          'div',
          { class: 'guardians' },
          gs.map((g) =>
            h(
              'div',
              { class: `guardian ${g.up && g.key_ok ? 'up' : 'down'}` },
              h('span', { class: 'g-id' }, `Keyholder ${g.id}`),
              h('span', { class: 'g-state' }, h('span', { class: `dot ${g.up && g.key_ok ? 'live' : 'bad'}`, 'aria-hidden': 'true' }), g.up ? (g.key_ok ? 'online' : 'wrong key') : 'offline'),
            ),
          ),
        ),
        h('p', { class: `hint ${up >= 2 ? 't-ok' : 't-bad'}` }, up >= 2 ? 'Cash-outs can be approved.' : 'Cash-outs wait until two keyholders are back online.'),
      );

      moreBody.replaceChildren(
        ...[
          h('p', { class: 'hint' }, 'The keyholders are the mint’s FROST guardians: the reserve is spent only with a 2-of-3 threshold signature, and each one re-checks every withdrawal against the mint before signing.'),
          r ? kv('Reserve (confirmed, shielded)', `${fmtZat(r.reserve_zats ?? 0)} zats`) : null,
          r ? kv('Ecash outstanding', `${fmtZat(r.outstanding_zats ?? 0)} zats`) : null,
          r ? kv('Withdrawals in flight', `${fmtZat(r.in_flight_zats ?? 0)} zats`) : null,
          r ? kv('Issued / redeemed', `${fmtZat(r.ledger?.issued ?? 0)} / ${fmtZat(r.ledger?.redeemed ?? 0)}`) : null,
          r ? kv('Melting now', `${fmtZat(r.ledger?.pending_melt ?? 0)} zats`) : null,
          r ? kv('Reserve ratio', (r.required_zats ?? 0) > 0 ? `${(((r.reserve_zats ?? 0) / r.required_zats!) * 100).toFixed(1)}%` : '—') : null,
          r ? kv('Chain height', fmtZat(r.chain_height ?? 0)) : null,
          r ? kv('Deposits credited after', r.min_confirmations === undefined ? '?' : plural(r.min_confirmations, 'confirmation')) : null,
          r ? kv('Reserve checked', r.error ? `failed: ${r.error}` : ago(r.checked_at)) : null,
          ...gs.map((g) => kv(`Guardian G${g.id}`, `${g.up ? (g.key_ok ? 'up' : 'wrong key') : 'down'} · seen ${ago(g.last_seen)}`)),
          ...(r?.operator_action ?? []).map((a) => kv(`Operator action ${a.quote_id.slice(0, 8)}…`, `${fmtZat(a.amount_zats)} zats · ${ago(a.flagged_at)}`)),
          kv('Network', app.core.mainnet ? 'MAINNET' : 'regtest'),
          kv('Mint', app.core.mintUrl),
          kv('Refreshed', lastAt ? ago(lastAt / 1000) : 'never'),
        ].filter((x) => x !== null),
      );
    };

    const load = async () => {
      try {
        last = await fetchReserves();
        lastAt = Date.now();
        failed = false;
      } catch {
        failed = true;
      }
      draw();
    };
    draw();
    void load();
    const timers = [setInterval(() => void load(), 10_000)];

    const el = h(
      'div',
      { class: 'page status-page' },
      pageHead('Is my money safe?', { back: true }),
      h(
        'p',
        { class: 'lead' },
        'The mint is the service that issues this digital cash and holds the real ZEC behind it, like a vault that prints banknotes only for money it has. Every ZEC of cash in circulation is backed by ZEC held in its shielded Zcash wallet.',
      ),
      hero,
      keys,
      more,
    );
    return { el, cleanup: () => timers.forEach(clearInterval) };
  },
};
