// The sales dashboard: a period, the key figures, daily sales (hand-drawn SVG bars with a
// tooltip), top items, invoices by state, counter vs sent, and recent invoices. Everything is
// worked out on this device from the stored invoices.
import { busy, h } from '../../ui/dom';
import { go } from '../../ui/router';
import { moneyEl, pageHead, type App, type Page } from '../../ui/widgets';
import { moneyText } from '../../ui/words';
import { DAY, STATE_LABEL, invoicesCsv, nextDay, sales, startOfDay, type Period, type State } from '../model';
import type { Shop } from '../store';
import { badge, dayText, deliver, pdfKit, when } from './common';

type Pick = 'today' | '7' | '30' | 'month' | 'custom';
let chosen: Pick = '7';
let custom = { from: '', to: '' };

const dateValue = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

function periodOf(p: Pick): Period {
  const today = startOfDay(Date.now());
  const end = nextDay(today);
  if (p === 'today') return { from: today, to: end };
  if (p === 'month') {
    const d = new Date(today);
    d.setDate(1);
    return { from: d.getTime(), to: end };
  }
  if (p === 'custom' && custom.from && custom.to) {
    const from = new Date(`${custom.from}T00:00`).getTime();
    const to = nextDay(new Date(`${custom.to}T00:00`).getTime());
    if (to > from) return { from, to };
  }
  const n = p === '30' ? 30 : 7;
  return { from: startOfDay(today - (n - 1) * DAY + DAY / 2), to: end };
}

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** Daily bars, drawn by hand; hover or tap a bar for its day. */
function bars(days: Array<{ day: number; total: number; count: number }>) {
  const W = 720;
  const H = 220;
  const pad = { l: 8, r: 8, t: 16, b: 26 };
  const max = Math.max(1, ...days.map((d) => d.total));
  const bw = (W - pad.l - pad.r) / Math.max(1, days.length);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img', 'aria-label': `Daily sales: ${days.map((d) => `${dayText(d.day)} ${moneyText(d.total)}`).join(', ')}` });
  svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, class: 'axis' }));
  for (const f of [0.5, 1]) svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b - f * (H - pad.t - pad.b), y2: H - pad.b - f * (H - pad.t - pad.b), class: 'grid' }));
  const tip = h('div', { class: 'bar-tip', hidden: true, role: 'status' });
  const every = Math.ceil(days.length / 10);
  days.forEach((d, i) => {
    const hgt = (d.total / max) * (H - pad.t - pad.b);
    const x = pad.l + i * bw;
    const g = s('g', { class: 'bar', tabindex: 0 });
    g.append(s('rect', { x: x, y: pad.t, width: bw, height: H - pad.t - pad.b, class: 'hit' }));
    if (d.total) g.append(s('rect', { x: x + bw * 0.18, y: H - pad.b - hgt, width: bw * 0.64, height: hgt, rx: 2, class: 'fill' }));
    if (i % every === 0) {
      const t = s('text', { x: x + bw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = dayText(d.day);
      g.append(t);
    }
    const show = () => {
      tip.hidden = false;
      tip.textContent = `${new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ${moneyText(d.total)} · ${d.count} ${d.count === 1 ? 'sale' : 'sales'}`;
      tip.style.left = `${((x + bw / 2) / W) * 100}%`;
    };
    g.addEventListener('mouseenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('click', show);
    g.addEventListener('mouseleave', () => (tip.hidden = true));
    svg.append(g);
  });
  return h('div', { class: 'chart' }, svg, tip, h('p', { class: 'hint' }, `Highest day ${moneyText(max === 1 && !days.some((d) => d.total) ? 0 : max)}`));
}

export const dashboardPage = (shop: Shop): Page => ({
  title: 'Dashboard',
  render(app) {
    const body = h('div', { class: 'dash' });
    const picker = h('div', { class: 'chips', role: 'group', 'aria-label': 'Period' });
    const from = h('input', { type: 'date', class: 'input', value: custom.from || dateValue(Date.now() - 6 * DAY), 'aria-label': 'From' });
    const to = h('input', { type: 'date', class: 'input', value: custom.to || dateValue(Date.now()), 'aria-label': 'To' });
    const customBox = h('div', { class: 'row wrap', hidden: chosen !== 'custom' }, from, to);
    from.oninput = to.oninput = () => {
      custom = { from: from.value, to: to.value };
      draw();
    };
    const opts: Array<[Pick, string]> = [
      ['today', 'Today'],
      ['7', '7 days'],
      ['30', '30 days'],
      ['month', 'This month'],
      ['custom', 'Custom'],
    ];
    for (const [k, label] of opts) {
      const b = h('button', { type: 'button', class: `chip-btn ${k === chosen ? 'on' : ''}`, 'aria-pressed': String(k === chosen) }, label);
      b.onclick = () => {
        chosen = k;
        picker.querySelectorAll('button').forEach((x) => (x.classList.toggle('on', x === b), x.setAttribute('aria-pressed', String(x === b))));
        customBox.hidden = k !== 'custom';
        if (k === 'custom') custom = { from: from.value, to: to.value };
        draw();
      };
      picker.append(b);
    }

    const tile = (label: string, value: Node | string, extra?: Node) => h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), typeof value === 'string' ? h('span', { class: 'tile-value mono' }, value) : value, extra ?? null);

    const draw = () => {
      const period = periodOf(chosen);
      const all = shop.rows();
      const f = sales(all, period);
      const states: State[] = ['paid', 'overpaid', 'open', 'partial', 'expired', 'cancelled', 'refunded', 'part-refunded'];
      const stateMax = Math.max(1, ...states.map((x) => f.byState.get(x) ?? 0));
      const kindMax = Math.max(1, f.counter + f.sent);
      const recent = all.filter((r) => r.inv.issuedAt).slice(0, 8);
      body.replaceChildren(
        h(
          'div',
          { class: 'tiles' },
          tile('Sales', moneyEl(f.total, { cls: 'tile-money' })),
          tile('Paid invoices', String(f.count)),
          tile('Average sale', moneyEl(f.average, { cls: 'tile-money' })),
          tile('Open / unpaid', moneyEl(f.openTotal, { cls: 'tile-money' }), h('span', { class: 'hint' }, `${f.openCount} open`)),
          tile('Refunds', moneyEl(f.refunds, { cls: 'tile-money' })),
          tile('Wallet balance', moneyEl(app.core.balance(), { cls: 'tile-money' }), h('a', { href: '#/withdraw', class: 'link' }, 'Cash out →')),
        ),
        h('section', { class: 'card dash-chart' }, h('h2', { class: 'section-title' }, 'Sales per day'), bars(f.days)),
        h(
          'div',
          { class: 'dash-row' },
          h(
            'section',
            { class: 'card' },
            h('h2', { class: 'section-title' }, 'Top items'),
            f.topItems.length
              ? h('table', { class: 'mini' }, h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'num' }, 'Sold'), h('th', { class: 'num' }, 'Revenue'))), h('tbody', null, f.topItems.slice(0, 8).map((it) => h('tr', null, h('td', null, it.name), h('td', { class: 'num mono' }, String(it.qty)), h('td', { class: 'num mono' }, moneyText(it.revenue))))))
              : h('p', { class: 'hint' }, 'Nothing sold in this period.'),
          ),
          h(
            'section',
            { class: 'card' },
            h('h2', { class: 'section-title' }, 'Invoices by state'),
            h('div', { class: 'hbars' }, states.filter((x) => f.byState.get(x)).map((x) => h('div', { class: 'hbar' }, h('span', null, STATE_LABEL[x]), h('span', { class: 'hbar-track' }, h('span', { class: `hbar-fill st-${x}`, style: `width:${((f.byState.get(x) ?? 0) / stateMax) * 100}%` })), h('span', { class: 'mono' }, String(f.byState.get(x)))))),
            f.byState.size ? '' : h('p', { class: 'hint' }, 'No invoices issued in this period.'),
            h('h2', { class: 'section-title kind-title' }, 'Counter vs sent'),
            h('div', { class: 'hbars' }, ...([['Counter', f.counter], ['Sent', f.sent]] as const).map(([k, v]) => h('div', { class: 'hbar' }, h('span', null, k), h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill st-paid', style: `width:${(v / kindMax) * 100}%` })), h('span', { class: 'mono' }, moneyText(v))))),
          ),
        ),
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Recent invoices'), h('a', { href: '#/invoices', class: 'link' }, 'All invoices →')),
          recent.length
            ? h(
                'table',
                { class: 'inv-table' },
                h('thead', null, h('tr', null, h('th', null, 'Number'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Total'), h('th', null, 'State'), h('th', null, 'Time'))),
                h(
                  'tbody',
                  null,
                  recent.map((r) =>
                    h(
                      'tr',
                      { class: 'inv-row', onclick: () => go(`/invoices?id=${encodeURIComponent(r.inv.id)}`) },
                      h('td', { 'data-label': 'Number' }, h('a', { href: `#/invoices?id=${encodeURIComponent(r.inv.id)}`, class: 'mono' }, r.inv.number!)),
                      h('td', { 'data-label': 'Customer' }, r.inv.customer?.name ?? (r.inv.kind === 'counter' ? 'Counter sale' : '—')),
                      h('td', { class: 'num mono', 'data-label': 'Total' }, moneyText(r.total)),
                      h('td', { 'data-label': 'State' }, badge(r.state)),
                      h('td', { 'data-label': 'Time' }, when(r.paidAt ?? r.inv.issuedAt)),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'hint' }, 'No invoices yet.'),
        ),
      );
      report.dataset.from = String(period.from);
    };

    const report = h('button', { type: 'button', class: 'btn' }, 'Sales report PDF');
    report.onclick = () =>
      void busy(report, async () => {
        const period = periodOf(chosen);
        const all = shop.rows();
        const f = sales(all, period);
        const inPeriod = all.filter((r) => r.inv.issuedAt && r.inv.issuedAt >= period.from && r.inv.issuedAt < period.to);
        const { reportPdf } = await pdfKit();
        const bytes = await reportPdf({ shop: shop.profile()?.name ?? 'Shop', from: period.from, to: period.to, figures: f, rows: inPeriod });
        await deliver(bytes, `sales-${dateValue(period.from)}-to-${dateValue(period.to - 1)}.pdf`, 'application/pdf');
      }, app.explain);
    const csv = h('button', { type: 'button', class: 'btn' }, 'CSV');
    csv.onclick = () => {
      const period = periodOf(chosen);
      const rs = shop.rows().filter((r) => r.inv.issuedAt && r.inv.issuedAt >= period.from && r.inv.issuedAt < period.to);
      void deliver(invoicesCsv(rs), `invoices-${dateValue(period.from)}-to-${dateValue(period.to - 1)}.csv`, 'text/csv');
    };
    draw();
    const el = h('div', { class: 'page wide' }, pageHead('Dashboard', { right: h('div', { class: 'row wrap no-print' }, report, csv) }), h('div', { class: 'stack' }, picker, customBox), body);
    const off = [shop.on(draw), app.onChange(draw)];
    const timer = setInterval(draw, 30_000);
    return { el, cleanup: () => (off.forEach((x) => x()), clearInterval(timer)) };
  },
});
