// Hash router: #/send?t=abc. Static hosting, Caddy's try_files and the service worker only ever
// see "/", so no server changes. In-app links push history entries (so the hardware back button
// walks back through pages); overlays (the "more" sheet, the camera) push an entry on the same
// URL, so back closes them instead of leaving the page. Old links (#/request?r=…, from before
// Request became part of Receive) are redirected in place.

export type Route = { path: string; params: URLSearchParams };

export const PATHS = [
  '/', '/send', '/scan', '/receive', '/activity', '/deposit', '/withdraw', '/status', '/settings', '/welcome',
  // shop mode, and what customers open from a shop's link
  '/charge', '/invoices', '/dashboard', '/shop', '/invoice', '/receipt',
  // hackathon judges: a claim link (#/claim/<token>) and the tour
  '/claim', '/judges',
] as const;
export type Path = (typeof PATHS)[number];

/** Pages that moved: the old path still works, with its parameters. */
export const REDIRECTS: Record<string, Path> = { '/request': '/receive' };

/** Pages whose data is in the path: #/invoice/<data> -> /invoice with d=<data> (#/claim/<token> too). */
const DATA_PATHS = ['/invoice', '/receipt', '/claim'];

/** '#/send?t=1' -> { path: '/send', params: t=1 }. Unknown paths go home. */
export function parse(hash: string): Route & { path: Path; moved?: boolean } {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  let path = (q < 0 ? raw : raw.slice(0, q)).replace(/\/+$/, '') || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  if (REDIRECTS[path]) return { path: REDIRECTS[path], params, moved: true };
  const data = DATA_PATHS.find((p) => path.startsWith(`${p}/`));
  if (data) {
    params.set('d', path.slice(data.length + 1));
    return { path: data as Path, params };
  }
  return { path: (PATHS as readonly string[]).includes(path) ? (path as Path) : '/', params };
}

type State = { idx: number; overlay?: string };
let render: (r: Route & { path: Path }) => void = () => {};
let lastHash = '';
const closers = new Map<string, () => void>();
/** How the page now showing was reached: a tap or link ('push'), back/forward ('pop'), or a (re)load. */
let how: 'push' | 'pop' | 'load' = 'load';
export const navKind = () => how;

const idx = () => (history.state as State | null)?.idx ?? 0;

function renderNow() {
  const r = parse(location.hash);
  if (r.moved) {
    const q = r.params.toString();
    history.replaceState(history.state, '', `#${r.path}${q ? `?${q}` : ''}`);
  }
  lastHash = location.hash;
  render(r);
}

/** Navigate to an in-app path ('/send?t=1'). `replace` doesn't add a history entry. */
export function go(path: string, replace = false) {
  const url = `#${path}`;
  how = 'push';
  if (url === location.hash && !replace) return renderNow();
  if (replace) history.replaceState({ idx: idx() } satisfies State, '', url);
  else history.pushState({ idx: idx() + 1 } satisfies State, '', url);
  renderNow();
}

/** Back within the app; to `fallback` if the user arrived straight on this page. */
export function back(fallback = '/') {
  if (idx() > 0) history.back();
  else go(fallback, true);
}

/** Registers an open overlay so back closes it; returns the function that closes it in code. */
export function openOverlay(name: string, close: () => void): () => void {
  history.pushState({ idx: idx() + 1, overlay: name } satisfies State, '', location.hash);
  closers.set(name, close);
  return () => {
    if (!closers.has(name)) return;
    closers.delete(name);
    close();
    if ((history.state as State | null)?.overlay === name) history.back();
  };
}

/** Closes an overlay by turning its history entry into `path` (a link inside the overlay). */
export function leaveOverlayTo(name: string, path: string) {
  const close = closers.get(name);
  closers.delete(name);
  close?.();
  if ((history.state as State | null)?.overlay === name) {
    history.replaceState({ idx: idx() } satisfies State, '', `#${path}`);
    renderNow();
  } else go(path);
}

export function start(onRoute: typeof render) {
  render = onRoute;
  if (!history.state) history.replaceState({ idx: 0 } satisfies State, '', location.hash || '#/');
  window.addEventListener('popstate', (e) => {
    const s = e.state as State | null;
    // An overlay's entry was popped (back button): close it, the page stays.
    for (const [name, close] of [...closers]) {
      if (s?.overlay !== name) {
        closers.delete(name);
        close();
      }
    }
    how = 'pop';
    if (location.hash !== lastHash) renderNow();
  });
  // Typed or external hash changes (no popstate in some browsers).
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    how = 'push';
    renderNow();
  });
  // Same-origin links like <a href="#/send"> go through go(), so they get an idx.
  document.addEventListener('click', (e) => {
    const a = (e.target as Element).closest?.('a[href^="#/"]') as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.getAttribute('href')!.slice(1));
  });
  renderNow();
}
