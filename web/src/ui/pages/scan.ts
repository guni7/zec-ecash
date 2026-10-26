// Scan anything: the camera opens at once (when the tab is tapped, not on back/forward or a
// reload), and what it reads decides what happens next (flows.ts).
import { h } from '../dom';
import { handleCode, scanBlock, type Ctx } from '../flows';
import { navKind } from '../router';
import { pageHead, type Page } from '../widgets';

export const scan: Page = {
  title: 'Scan',
  render(app) {
    const body = h('div', { class: 'flow' });
    const ctx: Ctx = { app, show: (v) => body.replaceChildren(v), restart: () => start(false) };
    const start = (camera: boolean) => {
      const block = scanBlock({ label: 'Scan a code', prompt: 'Point the camera at a code', onText: (t) => handleCode(ctx, t, 'scan', block.say) });
      body.replaceChildren(block.el);
      if (camera) block.scan.click();
    };
    start(navKind() === 'push');
    return { el: h('div', { class: 'page' }, pageHead('Scan'), body) };
  },
};
