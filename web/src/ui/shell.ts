// The frame around every page: network strip (MAINNET is permanent), offline indicator, desktop
// sidebar (>= 900 px), phone top bar + bottom tab bar + "more" sheet, and toasts.
import { h, svg, ICON, setToast } from './dom';
import { leaveOverlayTo, openOverlay, type Path } from './router';

export type NavItem = { path: Path; label: string; icon: string; tab?: boolean };

export const NAV: NavItem[] = [
  { path: '/', label: 'Home', icon: ICON.home, tab: true },
  { path: '/send', label: 'Send', icon: ICON.send, tab: true },
  { path: '/receive', label: 'Receive', icon: ICON.receive, tab: true },
  { path: '/activity', label: 'Activity', icon: ICON.activity, tab: true },
  { path: '/deposit', label: 'Deposit', icon: ICON.deposit },
  { path: '/withdraw', label: 'Withdraw', icon: ICON.withdraw },
  { path: '/request', label: 'Request', icon: ICON.request },
  { path: '/status', label: 'Status', icon: ICON.status },
  { path: '/settings', label: 'Settings', icon: ICON.settings },
];

export function createShell(opts: { mainnet: boolean; mintHost: string; onBack: () => void }) {
  const view = h('main', { id: 'view', class: 'view', tabindex: '-1' });
  const title = h('h1', { class: 'topbar-title' });
  const backBtn = h('button', { type: 'button', class: 'icon-btn back', 'aria-label': 'Back', onclick: opts.onBack }, svg(ICON.back));
  const mintDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const mintDot2 = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const offline = h('div', { class: 'offline', role: 'status', hidden: true });
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  const navLink = (n: NavItem, cls: string) =>
    h('a', { href: `#${n.path}`, class: cls, 'data-path': n.path }, svg(n.icon), h('span', null, n.label));

  const netbar = opts.mainnet
    ? h('div', { class: 'netbar mainnet', role: 'note' }, h('strong', null, '● MAINNET'), h('span', null, 'real ZEC'), h('span', { class: 'wide-only' }, '· experimental mint · small amounts only'))
    : h('div', { class: 'netbar regtest', role: 'note' }, h('strong', null, 'REGTEST'), h('span', null, 'test coins'), h('span', { class: 'wide-only' }, '· demo devnet, worthless'));

  const sidebar = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Main' },
    h('a', { href: '#/', class: 'brand', 'aria-label': 'zec-ecash home' }, h('span', { class: 'brand-mark' }, 'ZEC'), h('span', { class: 'brand-slash' }, '/'), h('span', null, 'ecash'), h('span', { class: 'cursor', 'aria-hidden': 'true' })),
    h('nav', { class: 'side-nav' }, NAV.map((n) => navLink(n, 'side-link'))),
    h('div', { class: 'side-foot mono' }, mintDot2, h('span', null, opts.mintHost)),
  );

  const moreBtn = h('button', { type: 'button', class: 'tab', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, svg(ICON.more), h('span', null, 'More'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main' }, NAV.filter((n) => n.tab).map((n) => navLink(n, 'tab')), moreBtn);

  const topbar = h('header', { class: 'topbar' }, backBtn, title, h('span', { class: 'topbar-mint', title: opts.mintHost }, mintDot));

  // The "more" sheet (phones): the pages not in the tab bar.
  let closeSheet: (() => void) | null = null;
  function openSheet() {
    if (closeSheet) return;
    const links = NAV.filter((n) => !n.tab).map((n) =>
      h(
        'a',
        {
          href: `#${n.path}`,
          class: 'sheet-link',
          onclick: (e: MouseEvent) => {
            e.preventDefault();
            closeSheet = null;
            leaveOverlayTo('more', n.path);
          },
        },
        svg(n.icon),
        h('span', null, n.label),
      ),
    );
    const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'More pages' }, h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), h('nav', { class: 'sheet-nav' }, links));
    const backdrop = h('div', { class: 'sheet', onclick: (e: MouseEvent) => e.target === backdrop && closeSheet?.() }, panel);
    document.body.append(backdrop);
    moreBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => backdrop.classList.add('open'));
    (links[0] as HTMLElement).focus({ preventScroll: true });
    closeSheet = openOverlay('more', () => {
      closeSheet = null;
      moreBtn.setAttribute('aria-expanded', 'false');
      backdrop.remove();
    });
  }
  moreBtn.onclick = () => openSheet();
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet?.());



  const inlineToasts = h('div', { class: 'toasts-inline', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'app' }, sidebar, h('div', { class: 'main' }, netbar, offline, topbar, inlineToasts, view), tabbar, toasts);

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
    /** After a page renders: one that takes messages itself (data-toast-sink) gets no toasts. */
    afterRender() {
      if (view.querySelector('[data-toast-sink]')) {
        toasts.replaceChildren();
        inlineToasts.replaceChildren();
      } else placeToasts();
    },
    /** Highlights the current page in both navs; shows the back button off the tab pages. */
    setRoute(path: Path, label: string) {
      title.textContent = label;
      const tab = NAV.find((n) => n.path === path)?.tab ?? false;
      backBtn.hidden = tab;
      root.dataset.page = path.slice(1) || 'home';
      for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-path]')) {
        if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      moreBtn.classList.toggle('active', !tab);
    },
    setConnectivity(online: boolean, mintUp: boolean | null) {
      const ok = online && mintUp !== false;
      for (const d of [mintDot, mintDot2]) d.className = `dot ${mintUp === null ? '' : ok ? 'live' : 'bad'}`;
      offline.hidden = ok;
      offline.textContent = !online
        ? 'OFFLINE · your ecash is safe in this browser; locked tokens can still be accepted'
        : 'MINT UNREACHABLE · retrying; your ecash is safe in this browser';
    },
  };
}
