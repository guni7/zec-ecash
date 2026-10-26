// Full-screen camera scanner. Back (hardware or the close button) cancels it.
import QrScanner from 'qr-scanner';
import { h, svg, ICON, toast } from './dom';
import { openOverlay } from './router';

let open = false;

/** Largest side, in px, a camera frame is decoded at. qr-scanner's default is 400, which leaves a
 * dense code (a locked token with DLEQ proofs: ~165 modules) under 2 px per module. */
export const DECODE_PX = 800;

/** The centre 3/4 of the frame, decoded at up to DECODE_PX (never upscaled). */
function scanRegion(video: HTMLVideoElement) {
  const side = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.75);
  const px = Math.min(side, DECODE_PX);
  return { x: Math.round((video.videoWidth - side) / 2), y: Math.round((video.videoHeight - side) / 2), width: side, height: side, downScaledWidth: px, downScaledHeight: px };
}

/** Resolves with the first QR code read, or null if cancelled. */
export function scanQr(prompt: string): Promise<string | null> {
  if (open) return Promise.resolve(null);
  open = true;
  return new Promise((resolve) => {
    const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Camera preview' });
    const closeBtn = h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': 'Close camera' }, svg(ICON.close));
    const overlay = h(
      'div',
      { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scan a QR code' },
      h('div', { class: 'scanner-bar' }, h('span', { class: 'tag' }, '[ SCAN ]'), h('span', { class: 'scanner-prompt' }, prompt), closeBtn),
      h('div', { class: 'scanner-view' }, video),
    );
    document.body.append(overlay);
    let result: string | null = null;
    const scanner = new QrScanner(
      video,
      (r) => {
        result = r.data;
        close();
      },
      { preferredCamera: 'environment', highlightScanRegion: true, highlightCodeOutline: true, returnDetailedScanResult: true, calculateScanRegion: scanRegion },
    );
    const close = openOverlay('scanner', () => {
      scanner.stop();
      scanner.destroy();
      overlay.remove();
      open = false;
      resolve(result);
    });
    closeBtn.onclick = () => close();
    scanner.start().catch((e) => {
      close();
      toast(`Camera unavailable: ${e instanceof Error ? e.message : e}. (Needs HTTPS and camera permission.)`, 'bad');
    });
  });
}
