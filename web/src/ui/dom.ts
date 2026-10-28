// Tiny DOM helpers: h() builds elements, plus formatting and copy-to-clipboard bits.
import { zatToZec } from '../wallet/onchain';

type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, unknown>;

/** h('button', { class: 'btn', onclick }, 'Label'). `on*` attrs are listeners; others attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el: Element, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

/** Raw SVG markup to an element (icons are static strings in this bundle). */
export function svg(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild!;
}

const group = new Intl.NumberFormat('en-US');
export const fmtZat = (n: number) => group.format(n);
export const fmtZec = (n: number) => `${zatToZec(Math.abs(n))} ZEC`;

/** plural(1, 'confirmation') -> '1 confirmation'; plural(3, 'withdrawal') -> '3 withdrawals' */
export const plural = (n: number, word: string, many = `${word}s`) => `${fmtZat(n)} ${n === 1 ? word : many}`;

/** u1uwp7…082s */
export const shortAddr = (s: string, head = 6, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function countdown(expiry: number | null): string {
  if (!expiry) return '';
  const s = Math.round(expiry - Date.now() / 1000);
  if (s <= 0) return 'expired';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastFn: (text: string, tone?: 'ok' | 'bad' | '') => void = () => {};
export const setToast = (fn: typeof toastFn) => (toastFn = fn);
export const toast = (text: string, tone: 'ok' | 'bad' | '' = '') => toastFn(text, tone);

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'ok');
  } catch {
    toast(`Copy blocked by the browser: select the ${what.toLowerCase()} and copy it by hand.`, 'bad');
  }
}

/** iPhone or iPad (iPadOS reports a Mac, but one with touch). */
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Opened from the Home Screen (installed), not in a browser tab. */
export const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * A file to the person: the share sheet on a phone (Save to Files, AirDrop, …), else a download.
 * The installed iOS app never gets a plain download: it would open the file with no way back.
 * Returns false if the person cancelled.
 */
export async function saveFile(bytes: BlobPart, name: string, type: string): Promise<boolean> {
  const file = new File([bytes], name, { type });
  const iosApp = isIos() && standalone();
  if ((iosApp || matchMedia('(pointer: coarse)').matches) && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      const why = (e as Error).name;
      if (why === 'AbortError') return false;
      // Safari shares only right after a tap; building the file can use that up: ask for one more
      if (why === 'NotAllowedError') return saveOnTap(file);
    }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Saved ${name}`, 'ok');
  return true;
}

/** "Your file is ready" with a Save button, whose tap opens the share sheet. */
function saveOnTap(file: File): Promise<boolean> {
  return new Promise((done) => {
    const save = h('button', { type: 'button', class: 'btn primary' }, svg(ICON.share), 'Save');
    const cancel = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const sheet = h('div', { class: 'save-sheet', role: 'dialog', 'aria-label': 'Save file' }, h('p', null, h('strong', null, file.name), ' is ready.'), h('div', { class: 'row wrap' }, save, cancel));
    const close = (saved: boolean) => (sheet.remove(), done(saved));
    save.onclick = () => void navigator.share({ files: [file], title: file.name }).then(() => close(true), () => close(false));
    cancel.onclick = () => close(false);
    document.body.append(sheet);
    save.focus();
  });
}

/** A tap-to-copy chip showing u1uwp7…082s; the full text is in its label. */
export function copyChip(text: string, what: string, head = 6, tail = 4) {
  return h(
    'button',
    { type: 'button', class: 'chip mono', title: text, 'aria-label': `Copy ${what.toLowerCase()} ${text}`, onclick: () => void copyText(text, what) },
    shortAddr(text, head, tail),
    svg(ICON.copy),
  );
}

/** [ LABEL ] */
export const tag = (text: string, cls = '') => h('span', { class: `tag ${cls}` }, `[ ${text} ]`);

/** Runs `work` with the button disabled; failures become a toast. */
export async function busy<T>(button: HTMLButtonElement, work: () => Promise<T>, explain: (e: unknown) => string): Promise<T | undefined> {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await work();
  } catch (e) {
    const text = explain(e); // '' when the caller showed the failure itself
    if (text) toast(text, 'bad');
    return undefined;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

const I = (d: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${d}</svg>`;
export const ICON = {
  home: I('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  send: I('<path d="M7 17 17 7"/><path d="M8 7h9v9"/>'),
  receive: I('<path d="M17 7 7 17"/><path d="M16 17H7V8"/>'),
  activity: I('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  more: I('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  deposit: I('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>'),
  withdraw: I('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 20h16"/>'),
  request: I('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>'),
  status: I('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
  // A cog (toothed ring), not rays: rays read as a light/dark switch.
  settings: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  back: I('<path d="M15 5 8 12l7 7"/>'),
  copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 9h11v11H9z"/><path d="M5 15H4V4h11v1"/></svg>',
  share: I('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v8h14v-8"/>'),
  scan: I('<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M4 12h16"/>'),
  close: I('<path d="m6 6 12 12M18 6 6 18"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  charge: I('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/><path d="M15 15l2 2 3-4"/>'),
  invoice: I('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h7"/>'),
  chart: I('<path d="M4 20h16"/><path d="M7 16v-5M12 16V7M17 16v-8"/>'),
  wallet: I('<path d="M3 7h16v12H3z"/><path d="M3 7l12-3v3"/><path d="M15 12h4v3h-4z"/>'),
  shop: I('<path d="M4 9 6 4h12l2 5"/><path d="M4 9h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 11z"/><path d="M5 14v6h14v-6"/>'),
  check: '<svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square" aria-hidden="true"><circle cx="24" cy="24" r="21"/><path d="m14 25 7 7 13-15"/></svg>',
  alert: '<svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square" aria-hidden="true"><circle cx="24" cy="24" r="21"/><path d="M24 13v14M24 33v3"/></svg>',
  shield: I('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
  external: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14"/><path d="M18 14v6H4V6h6"/></svg>',
};
