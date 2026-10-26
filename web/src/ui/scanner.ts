// Full-screen camera scanner. Back (hardware or the close button) cancels it; "Paste instead"
// closes it and asks the page for a paste box.
import QrScanner from 'qr-scanner';
import { h, svg, ICON } from './dom';
import { openOverlay } from './router';

let open = false;

/** A code read; the person chose to paste instead; or the camera can't be used (why). null: cancelled. */
export type ScanResult = { text: string } | { paste: true } | { error: string } | null;

/** Largest side, in px, a camera frame is decoded at. qr-scanner's default is 400, which leaves a
 * dense code (a locked token with DLEQ proofs: ~165 modules) under 2 px per module. */
export const DECODE_PX = 800;

/** The centre 3/4 of the frame, decoded at up to DECODE_PX (never upscaled). */
function scanRegion(video: HTMLVideoElement) {
  const side = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.75);
  const px = Math.min(side, DECODE_PX);
  return { x: Math.round((video.videoWidth - side) / 2), y: Math.round((video.videoHeight - side) / 2), width: side, height: side, downScaledWidth: px, downScaledHeight: px };
}

/** Resolves with the first QR code read (see ScanResult). */
export function scanQr(prompt: string): Promise<ScanResult> {
  if (open) return Promise.resolve(null);
  open = true;
  return new Promise((resolve) => {
    const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Camera preview' });
    const closeBtn = h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': 'Close camera' }, svg(ICON.close));
    const pasteBtn = h('button', { type: 'button', class: 'link-btn scanner-paste' }, 'Paste instead');
    const overlay = h(
      'div',
      { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan a code' },
      h('div', { class: 'scanner-bar' }, h('span', { class: 'scanner-prompt' }, prompt), closeBtn),
      h('div', { class: 'scanner-view' }, video),
      h('div', { class: 'scanner-foot' }, pasteBtn),
    );
    document.body.append(overlay);
    let result: ScanResult = null;
    const scanner = new QrScanner(
      video,
      (r) => {
        result = { text: r.data };
        close();
      },
      { preferredCamera: 'environment', highlightScanRegion: true, highlightCodeOutline: true, returnDetailedScanResult: true, calculateScanRegion: scanRegion },
    );
    const close = openOverlay('scanner', () => {
      scanner.stop();
      scanner.destroy();
      overlay.remove();
      open = false;
      // Closed in code (a code was read): the overlay's history entry is popped next, and
      // asynchronously. Answer after that, or a page the caller opens would be popped with it.
      if ((history.state as { overlay?: string } | null)?.overlay === 'scanner') addEventListener('popstate', () => resolve(result), { once: true });
      else resolve(result);
    });
    closeBtn.onclick = () => close();
    pasteBtn.onclick = () => {
      result = { paste: true };
      close();
    };
    scanner.start().catch((e) => {
      const why = String(e instanceof Error ? e.message : e);
      result = { error: /denied|NotAllowed|permission/i.test(why) ? 'The camera is blocked. Allow it in your browser’s settings, or paste the code instead.' : 'No camera here. Paste the code instead.' };
      close();
    });
  });
}
