// Pieces the shop pages share: state badges, totals blocks, line tables, PDF and CSV delivery
// (the share sheet on phones, a download on desktop), and links.
import { h, saveFile } from '../../ui/dom';
import { kv, moneyEl } from '../../ui/widgets';
import { moneyText } from '../../ui/words';
import { STATE_LABEL, type Line, type State } from '../model';

export const TONE: Record<State, string> = {
  draft: 'muted',
  open: 'live',
  partial: 'warn',
  paid: 'ok',
  overpaid: 'warn',
  expired: 'muted',
  cancelled: 'muted',
  refunded: 'muted',
  'part-refunded': 'warn',
};

export const badge = (s: State) => h('span', { class: `badge b-${TONE[s]}`, 'data-state': s }, STATE_LABEL[s]);

export const linkFor = (kind: 'invoice' | 'receipt', data: string) => `${location.origin}/#/${kind}/${data}`;

export const when = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const dayText = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Items with quantities and amounts. */
export function linesTable(lines: readonly Line[]) {
  return h(
    'table',
    { class: 'lines' },
    h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Amount'))),
    h(
      'tbody',
      null,
      lines.map((l) => h('tr', null, h('td', null, l.desc), h('td', { class: 'num mono' }, String(l.qty)), h('td', { class: 'num mono' }, moneyText(l.unit)), h('td', { class: 'num mono' }, moneyText(Math.round(l.qty * l.unit))))),
    ),
  );
}

/** Subtotal, tax and the total (big). */
export function totalsBlock(t: { subtotal: number; tax: number; total: number }, taxRate?: number, included = true) {
  return h(
    'div',
    { class: 'totals' },
    taxRate ? kv('Subtotal', moneyText(t.subtotal)) : null,
    taxRate ? kv(`Tax ${taxRate}%${included ? ' (included)' : ''}`, moneyText(t.tax)) : null,
    h('div', { class: 'kv total' }, h('span', null, 'Total'), moneyEl(t.total, { cls: 'total-money' })),
  );
}

/** A file to the person: the share sheet on a phone (where it saves or sends it), else a download. */
export const deliver = (bytes: Uint8Array | string, name: string, type: string) => saveFile(bytes as BlobPart, name, type);

/** The PDF module, loaded the first time someone exports. */
export const pdfKit = () => import('../pdf');

/** A short beep and a buzz (the counter's Paid). The audio context is made on a tap, so it can play. */
let audio: AudioContext | null = null;
export function unlockSound() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    /* no sound */
  }
}
export function paidChime() {
  try {
    navigator.vibrate?.([120, 60, 120]);
    if (!audio) return;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.14 + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.14);
      o.stop(audio.currentTime + i * 0.14 + 0.25);
    }
  } catch {
    /* no sound */
  }
}

/** Keeps the screen on while `on`; returns the release. */
export async function keepAwake(): Promise<() => void> {
  let lock: WakeLockSentinel | null = null;
  const take = async () => {
    try {
      lock = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      lock = null;
    }
  };
  const again = () => document.visibilityState === 'visible' && void take();
  await take();
  document.addEventListener('visibilitychange', again);
  return () => {
    document.removeEventListener('visibilitychange', again);
    void lock?.release().catch(() => {});
  };
}

/** "12:04" until `t`, or "expired". */
export function countdownTo(t?: number) {
  if (!t) return '';
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  const h_ = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h_ ? `${h_} h ${m} min` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
