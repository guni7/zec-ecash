// The frame around every page: network strip (MAINNET is permanent) with the connection dot,
// offline indicator, desktop sidebar (>= 900 px), phone tab bar with Scan in the middle, and
// toasts. Each page draws its own one-line title.
import { h, svg, ICON, setToast } from './dom';
import type { Path } from './router';

export type NavItem = { path: Path; label: string; icon: string; primary?: boolean };

export const NAV: NavItem[] = [
  { path: '/', label: 'Home', icon: ICON.home },
  { path: '/send', label: 'Send', icon: ICON.send },
  { path: '/scan', label: 'Scan', icon: ICON.scan, primary: true },
  { path: '/receive', label: 'Receive', icon: ICON.receive },
  { path: '/activity', label: 'Activity', icon: ICON.activity },
];

export function createShell(opts: { mainnet: boolean; mintHost: string }) {
  const view = h('main', { id: 'view', class: 'view', tabindex: '-1' });
  const mintDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const mintDot2 = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const offline = h('div', { class: 'offline', role: 'status', hidden: true });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  const navLink = (n: NavItem, cls: string) =>
    h('a', { href: `#${n.path}`, class: `${cls} ${n.primary ? 'primary' : ''}`, 'data-path': n.path }, h('span', { class: 'tab-icon' }, svg(n.icon)), h('span', null, n.label));

  const netbar = opts.mainnet
    ? h('div', { class: 'netbar mainnet', role: 'note' }, h('strong', null, '● MAINNET'), h('span', null, 'real ZEC'), h('span', { class: 'wide-only' }, '· experimental · small amounts only'), mintDot)
    : h('div', { class: 'netbar regtest', role: 'note' }, h('strong', null, 'REGTEST'), h('span', null, 'test coins'), h('span', { class: 'wide-only' }, '· worthless'), mintDot);

  const sidebar = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Main' },
    h('a', { href: '#/', class: 'brand', 'aria-label': 'zec-ecash home' }, h('span', { class: 'brand-mark' }, 'ZEC'), h('span', { class: 'brand-slash' }, '/'), h('span', null, 'ecash'), h('span', { class: 'cursor', 'aria-hidden': 'true' })),
    h('nav', { class: 'side-nav' }, NAV.map((n) => navLink(n, 'side-link'))),
    h('div', { class: 'side-foot mono' }, mintDot2, h('span', null, opts.mintHost)),
  );

  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, NAV.map((n) => navLink(n, 'tab')));

  const inlineToasts = h('div', { class: 'toasts-inline', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'app' }, sidebar, h('div', { class: 'main' }, netbar, offline, inlineToasts, view), tabbar, toasts);

  /** Toasts never cover a QR code: bottom if that is clear, else top, else in the page flow. */
  function placeToasts() {
    const all = [...toasts.children, ...inlineToasts.children];
    if (!all.length) return;
    const qrs = [...document.querySelectorAll('.qr-card')]
      .map((q) => q.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight);
    const hits = () => {
      const t = toasts.getBoundingClientRect();
      return qrs.some((r) => !(t.bottom <= r.top || t.top >= r.bottom || t.right <= r.left || t.left >= r.right));
    };
    toasts.append(...all);
    for (const at of ['bottom', 'top'] as const) {
      toasts.dataset.at = at;
      if (!hits()) return;
    }
    inlineToasts.append(...all);
  }
  addEventListener('scroll', placeToasts, { passive: true });
  addEventListener('resize', placeToasts);
  // QR codes draw asynchronously and pages change height: re-check whenever the page resizes.
  new ResizeObserver(() => placeToasts()).observe(view);

  setToast((text, tone = '') => {
    // A page can take messages itself (the deposit awaiting payment, around its QR code):
    // errors go in its line, the rest is dropped.
    const sink = view.querySelector<HTMLElement>('[data-toast-sink]');
    if (sink) {
      if (tone === 'bad') {
        sink.textContent = text;
        sink.className = 'inline-msg t-bad';
      }
      return;
    }
    // A result or a code on screen already says how it went: no success toast on top of it.
    if (tone === 'ok' && view.querySelector('.result, .qr-card')) return;
    // The same message twice in a row shows once.
    if ([...toasts.children, ...inlineToasts.children].some((t) => t.textContent === text)) return;
    // At most two at a time (newest wins), gone after about 4 s, and a tap dismisses one.
    for (const old of [...toasts.children, ...inlineToasts.children].slice(0, -1)) old.remove();
    const t = h('div', { class: `toast ${tone}`, onclick: () => t.remove() }, text);
    toasts.append(t);
    placeToasts();
    setTimeout(() => t.classList.add('out'), 3600);
    setTimeout(() => t.remove(), 4100);
  });

  return {
    root,
    view,
    /** After a page renders: one that takes messages itself (data-toast-sink) gets no toasts; one
     * showing a code or a result keeps only errors. */
    afterRender() {
      const sink = !!view.querySelector('[data-toast-sink]');
      const quiet = !!view.querySelector('.result, .qr-card');
      for (const t of [...toasts.children, ...inlineToasts.children]) if (sink || (quiet && !t.classList.contains('bad'))) t.remove();
      placeToasts();
    },
    /** Highlights the current page in both navs (Add money, Cash out, Status and Settings sit under Home). */
    setRoute(path: Path) {
      root.dataset.page = path.slice(1) || 'home';
      const under: Partial<Record<Path, Path>> = { '/deposit': '/', '/withdraw': '/', '/status': '/', '/settings': '/', '/welcome': '/' };
      const current = under[path] ?? path;
      for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-path]')) {
        if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
        a.classList.toggle('active', a.dataset.path === current);
      }
    },
    setConnectivity(online: boolean, mintUp: boolean | null) {
      const ok = online && mintUp !== false;
      for (const d of [mintDot, mintDot2]) d.className = `dot ${mintUp === null ? '' : ok ? 'live' : 'bad'}`;
      offline.hidden = ok;
      offline.textContent = !online ? 'Offline · your money is safe on this device' : 'Can’t reach the service · retrying; your money is safe on this device';
    },
  };
}
