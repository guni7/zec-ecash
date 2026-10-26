// Public status page (for judges and users): proof of reserves and guardian health, live.
import { fetchReserves, type Reserves } from '../../wallet/status';
import { fmtZat, fmtZec, h, plural } from '../dom';
import { pageHead, type Page } from '../widgets';

const STATE: Record<Reserves['state'], [string, string, string]> = {
  ok: ['RESERVES OK', 'live', 'Every outstanding ecash zat and every withdrawal in flight is covered by confirmed ZEC in the shielded reserve.'],
  violated: ['RESERVE SHORT', 'bad', 'The confirmed reserve is below outstanding ecash plus withdrawals in flight. New deposits are refused until it is restored.'],
  operator_action_required: ['NEEDS OPERATOR', 'warn', 'The reserve covers everything, but a withdrawal needs a person to finish it.'],
  unknown: ['CHECKING', 'muted', 'The first reserve check has not finished yet.'],
};

export const status: Page = {
  title: 'Status',
  render(app) {
    const hero = h('section', { class: 'status-hero' });
    const grid = h('div', { class: 'status-grid' });
    const guardians = h('section', { class: 'section card' });
    const foot = h('p', { class: 'hint center mono' });
    let last: Reserves | null = null;
    let lastAt = 0;
    let failed = false;

    const ago = (unix?: number | null) => {
      if (!unix) return 'never';
      const s = Math.max(0, Math.round(Date.now() / 1000 - unix));
      return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
    };

    const draw = () => {
      const r = last;
      if (!r) {
        hero.replaceChildren(h('span', { class: 'tag' }, '[ PROOF OF RESERVES ]'), h('div', { class: 'state-word t-muted' }, failed ? 'UNREACHABLE' : 'LOADING'));
        return;
      }
      const [word, tone, text] = STATE[r.state] ?? STATE.unknown;
      const reserve = r.reserve_zats ?? 0;
      const required = r.required_zats ?? 0;
      const ratio = required > 0 ? reserve / required : null;
      const scale = Math.max(reserve, required, 1);
      hero.replaceChildren(
        h('div', { class: 'hero-top' }, h('span', { class: 'tag' }, '[ PROOF OF RESERVES ]'), h('span', { class: `live-chip ${failed ? 'stale' : ''}` }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), failed ? 'STALE' : 'LIVE')),
        h('div', { class: `state-word t-${tone}` }, word),
        h('p', { class: 'lead' }, text),
        h(
          'div',
          { class: 'coverage', role: 'img', 'aria-label': `Reserve ${reserve} zat against ${required} zat required` },
          h('div', { class: 'cov-row' }, h('span', { class: 'cov-label' }, 'Reserve'), h('div', { class: 'cov-track' }, h('div', { class: 'cov-fill reserve', style: `width:${(reserve / scale) * 100}%` })), h('span', { class: 'mono cov-num' }, fmtZat(reserve))),
          h(
            'div',
            { class: 'cov-row' },
            h('span', { class: 'cov-label' }, 'Owed'),
            h(
              'div',
              { class: 'cov-track' },
              h('div', { class: 'cov-fill outstanding', style: `width:${((r.outstanding_zats ?? 0) / scale) * 100}%` }),
              h('div', { class: 'cov-fill inflight', style: `width:${((r.in_flight_zats ?? 0) / scale) * 100}%` }),
            ),
            h('span', { class: 'mono cov-num' }, fmtZat(required)),
          ),
          h(
            'p',
            { class: 'cov-legend hint' },
            [['reserve', 'confirmed ZEC'], ['outstanding', 'outstanding ecash'], ['inflight', 'withdrawals in flight']].map(([c, t]) => h('span', { class: 'nowrap legend-item' }, h('i', { class: `sw ${c}` }), t)),
          ),
        ),
        ratio !== null ? h('div', { class: 'ratio mono' }, h('span', { class: 'ratio-num' }, `${(ratio * 100).toFixed(ratio >= 10 ? 0 : 1)}%`), h('span', { class: 'hint' }, ' collateralised')) : '',
      );
      const stat = (label: string, value: string, sub?: string) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value mono' }, value), sub ? h('span', { class: 'stat-sub mono' }, sub) : null);
      grid.replaceChildren(
        stat('Reserve', `${fmtZat(reserve)} zat`, fmtZec(reserve)),
        stat('Outstanding ecash', `${fmtZat(r.outstanding_zats ?? 0)} zat`, fmtZec(r.outstanding_zats ?? 0)),
        stat('In flight', `${fmtZat(r.in_flight_zats ?? 0)} zat`, 'withdrawals not mined yet'),
        stat('Issued / redeemed', `${fmtZat(r.ledger?.issued ?? 0)} / ${fmtZat(r.ledger?.redeemed ?? 0)}`, `${fmtZat(r.ledger?.pending_melt ?? 0)} melting`),
        stat('Chain height', fmtZat(r.chain_height ?? 0), `${r.min_confirmations === undefined ? '?' : plural(r.min_confirmations, 'confirmation')} to credit a deposit`),
        stat('Checked', ago(r.checked_at), r.error ? `last check failed: ${r.error}` : 'after every sync'),
      );
      const up = r.guardians.filter((g) => g.up && g.key_ok).length;
      guardians.replaceChildren(
        h('div', { class: 'hero-top' }, h('span', { class: 'tag' }, '[ GUARDIANS ]'), h('span', { class: `mono ${up >= 2 ? 't-live' : 't-bad'}` }, `${up}/${r.guardians.length || 3} UP`)),
        h('h3', { class: 'section-title' }, up >= 2 ? 'Withdrawals can be signed' : 'Withdrawals are paused'),
        h('p', { class: 'hint' }, 'The reserve is spent only with a 2-of-3 FROST signature. Each guardian re-checks every withdrawal against the mint before signing.'),
        h(
          'div',
          { class: 'guardians' },
          (r.guardians.length ? r.guardians : [1, 2, 3].map((id) => ({ id, up: false, key_ok: false, last_seen: null }))).map((g) =>
            h(
              'div',
              { class: `guardian ${g.up && g.key_ok ? 'up' : 'down'}` },
              h('span', { class: 'g-id' }, `G${g.id}`),
              h('span', { class: 'g-state' }, h('span', { class: `dot ${g.up && g.key_ok ? 'live' : 'bad'}`, 'aria-hidden': 'true' }), g.up ? (g.key_ok ? 'up' : 'wrong key') : 'down'),
              h('span', { class: 'g-seen mono' }, g.up ? `seen ${ago(g.last_seen)}` : `last seen ${ago(g.last_seen)}`),
            ),
          ),
        ),
        r.operator_action?.length
          ? h(
              'div',
              { class: 'op-actions' },
              h('p', { class: 't-warn' }, `${plural(r.operator_action.length, 'withdrawal')} ${r.operator_action.length === 1 ? 'needs' : 'need'} the operator`),
              r.operator_action.map((a) => h('div', { class: 'kv' }, h('span', { class: 'mono' }, `${a.quote_id.slice(0, 8)}…`), h('span', { class: 'mono' }, `${fmtZat(a.amount_zats)} zat · ${ago(a.flagged_at)}`))),
            )
          : '',
      );
      foot.textContent = `${app.core.mainnet ? 'MAINNET' : 'REGTEST'} · ${app.core.mintUrl} · refreshed ${ago(lastAt / 1000)}`;
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
    const timers = [setInterval(() => void load(), 10_000), setInterval(draw, 1000)];

    const el = h('div', { class: 'page status-page' }, pageHead('STATUS', 'Mint status', 'Live from the mint: ZEC held vs ecash owed, and the guardians that co-sign withdrawals.'), hero, grid, guardians, foot);
    return { el, cleanup: () => timers.forEach(clearInterval) };
  },
};
