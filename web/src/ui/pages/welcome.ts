// First run: what this is, where the money lives, and a backup offered right away.
import { h, svg, ICON } from '../dom';
import { downloadBackup } from '../flows';
import { go } from '../router';
import { pageHead, type Page } from '../widgets';

export const welcome: Page = {
  title: 'Welcome',
  render(app) {
    const card = (n: number, title: string, text: string, extra?: Node) =>
      h('section', { class: 'welcome-card' }, h('span', { class: 'welcome-n mono', 'aria-hidden': 'true' }, `0${n}`), h('h2', null, title), h('p', null, text), extra ?? null);
    const saved = h('p', { class: 'hint t-ok', hidden: true }, 'Backup saved.');
    const backup = h('button', { type: 'button', class: 'btn block' }, 'Download backup');
    backup.onclick = () => {
      downloadBackup(app);
      saved.hidden = false;
    };
    const start = h('button', { type: 'button', class: 'btn primary block big' }, 'Get started');
    start.onclick = () => {
      app.prefs.set({ welcomed: true });
      go('/', true);
    };
    const el = h(
      'div',
      { class: 'page welcome' },
      pageHead('Welcome'),
      card(1, 'Digital cash for ZEC', 'To pay, one person shows a code and the other scans it. That’s it.'),
      card(2, 'Your money lives on this device', 'There’s no account and no password. If this browser’s data is deleted, the money goes with it.'),
      card(3, 'Back it up', 'A backup file brings your money back on another device. Keep it private: whoever has it can spend it.', h('div', { class: 'stack' }, backup, saved)),
      start,
      h('p', { class: 'hint center' }, svg(ICON.shield), ' Each ZEC here is backed by real ZEC: ', h('a', { href: '#/status' }, 'see how')),
    );
    return { el };
  },
};
