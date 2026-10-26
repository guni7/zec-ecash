// QR codes: always near-black on white with a 4-module quiet zone, inside a light card, whatever
// the theme around them (inverted or low-contrast codes fail to scan). Tap one to show it
// full-screen on white: dense codes (locked tokens with DLEQ proofs) need the extra size to scan.
import QRCode from 'qrcode';
import { h } from './dom';
import { openOverlay } from './router';

const OPTS = (ecc: 'L' | 'M' | 'Q') => ({ errorCorrectionLevel: ecc, margin: 4, scale: 8, color: { dark: '#0b0c0eff', light: '#ffffffff' } });

export function qrCard(text: string, opts: { label: string; ecc?: 'L' | 'M' | 'Q'; caption?: string }) {
  const ecc = opts.ecc ?? 'M';
  const canvas = h('canvas', { role: 'img', 'aria-label': opts.label });
  const card = h(
    'figure',
    { class: 'qr-card' },
    h('button', { type: 'button', class: 'qr-tap', 'aria-label': `${opts.label}. Show full screen`, onclick: () => fullscreen(text, ecc, opts.label) }, canvas),
    h('figcaption', null, [opts.caption, 'tap to enlarge'].filter(Boolean).join(' · ')),
  );
  // Drawn at 8 px per module; CSS scales it down crisply (image-rendering: pixelated).
  QRCode.toCanvas(canvas, text, OPTS(ecc)).catch(() => {
    card.replaceChildren(h('p', { class: 'qr-too-long' }, 'Too long for one QR code: copy the text instead.'));
  });
  return card;
}

function fullscreen(text: string, ecc: 'L' | 'M' | 'Q', label: string) {
  const canvas = h('canvas', { role: 'img', 'aria-label': label });
  const closeBtn = h('button', { type: 'button', class: 'btn qr-close' }, 'Close');
  const layer = h('div', { class: 'qr-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, canvas, h('p', null, 'Hold the camera close; turn your screen brightness up.'), closeBtn);
  void QRCode.toCanvas(canvas, text, OPTS(ecc));
  document.body.append(layer);
  const close = openOverlay('qr', () => layer.remove());
  closeBtn.onclick = () => close();
  canvas.onclick = () => close();
  closeBtn.focus({ preventScroll: true });
}
