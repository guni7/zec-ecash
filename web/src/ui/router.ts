// Hash router: #/send?t=abc. Static hosting, Caddy's try_files and the service worker only ever
// see "/", so no server changes. In-app links push history entries (so the hardware back button
// walks back through pages); overlays (the "more" sheet, the camera) push an entry on the same
// URL, so back closes them instead of leaving the page.

export type Route = { path: string; params: URLSearchParams };

export const PATHS = ['/', '/send', '/receive', '/deposit', '/withdraw', '/request', '/activity', '/status', '/settings'] as const;
export type Path = (typeof PATHS)[number];

/** '#/send?t=1' -> { path: '/send', params: t=1 }. Unknown paths go home. */
export function parse(hash: string): Route & { path: Path } {
  const raw = hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  let path = (q < 0 ? raw : raw.slice(0, q)).replace(/\/+$/, '') || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  return { path: (PATHS as readonly string[]).includes(path) ? (path as Path) : '/', params };
}

type State = { idx: number; overlay?: string };
let render: (r: Route & { path: Path }) => void = () => {};
let lastHash = '';
const closers = new Map<string, () => void>();

const idx = () => (history.state as State | null)?.idx ?? 0;

function renderNow() {
  lastHash = location.hash;
  render(parse(location.hash));
}

/** Navigate to an in-app path ('/send?t=1'). `replace` doesn't add a history entry. */
export function go(path: string, replace = false) {
  const url = `#${path}`;
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
    if (location.hash !== lastHash) renderNow();
  });
  // Typed or external hash changes (no popstate in some browsers).
  window.addEventListener('hashchange', () => {
    if (location.hash !== lastHash) renderNow();
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
