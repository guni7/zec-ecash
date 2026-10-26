import { getEncodedToken } from '@cashu/cashu-ts';
import { holdings, resetWallet, restoreBackup } from '../../wallet/backup';
import { ago, copyText, h, plural, toast } from '../dom';
import { downloadBackup } from '../flows';
import { details, field, kv, pageHead, type Page } from '../widgets';
import { moneyText } from '../words';

export const settings: Page = {
  title: 'Settings',
  render(app) {
    const network = app.core.mainnet ? 'mainnet' : 'regtest';
    const toggle = (label: string, note: string, checked: boolean, onchange: (on: boolean) => void) => {
      const box = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked });
      box.onchange = () => onchange(box.checked);
      return h('label', { class: 'toggle' }, box, h('span', null, h('strong', null, label), h('small', null, note)));
    };

    const backupState = h('p', { class: 'hint' });
    const showBackup = () => {
      const at = app.prefs.get().backupAt;
      backupState.textContent = at ? `Last backup: ${ago(at)}.` : 'Not backed up yet.';
      backupState.className = at ? 'hint' : 'hint t-warn';
    };
    showBackup();

    const copyAll = () => {
      const proofs = app.core.proofs();
      if (!proofs.length) return toast('There’s no money to copy.', 'bad');
      void copyText(getEncodedToken({ mint: app.core.mintUrl, unit: app.core.unit, proofs }), 'All your money as one code');
    };
    const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'restore-file' });
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        restoreBackup(await f.text(), app.core.mintUrl, network);
        toast('Backup restored. Reloading…', 'ok');
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        toast(app.explain(e), 'bad');
      }
      file.value = '';
    };

    const confirmInput = h('input', { type: 'text', class: 'input mono', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'RESET' });
    const resetBtn = h('button', { type: 'button', class: 'btn danger block', disabled: true }, 'Reset this wallet');
    confirmInput.oninput = () => (resetBtn.disabled = confirmInput.value.trim() !== 'RESET');
    const hold = holdings(app.core.mintUrl);
    resetBtn.onclick = () => {
      resetWallet(app.core.mintUrl);
      toast('Wallet reset. Reloading…', 'bad');
      setTimeout(() => (location.hash = '#/', location.reload()), 600);
    };

    const el = h(
      'div',
      { class: 'page' },
      pageHead('Settings', { back: true }),
      h(
        'section',
        { class: 'section card', 'aria-labelledby': 'set-backup' },
        h('h2', { class: 'tag', id: 'set-backup' }, '[ Backup ]'),
        h('p', null, 'Your money lives only on this device. A backup file restores it on another one; whoever has the file can spend it.'),
        backupState,
        h(
          'div',
          { class: 'row wrap' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => (downloadBackup(app), showBackup()) }, 'Download backup'),
          h('label', { for: 'restore-file', class: 'btn' }, 'Restore a backup…'),
          file,
        ),
      ),
      h(
        'section',
        { class: 'section card', 'aria-labelledby': 'set-display' },
        h('h2', { class: 'tag', id: 'set-display' }, '[ Display ]'),
        toggle('Show zats first', '“60,000 zats” instead of “0.0006 ZEC”. 1 ZEC is 100,000,000 zats.', !!app.prefs.get().zatsFirst, (on) => app.prefs.set({ zatsFirst: on })),
      ),
      h(
        'section',
        { class: 'section card' },
        h('h2', { class: 'tag' }, '[ Advanced ]'),
        details(
          toggle('Compact codes', 'Codes you show for anyone to take leave out the DLEQ proofs (NUT-12): about half the size, easier to scan. Codes locked to someone, or made offline, always keep them.', app.core.settings().compact, (on) => app.core.setSettings({ compact: on })),
          h('button', { type: 'button', class: 'btn block', onclick: copyAll }, 'Copy all money as one code'),
          kv('Mint', app.core.mintUrl),
          kv('Network', app.core.mainnet ? 'MAINNET (real ZEC)' : 'regtest (test coins)'),
          kv('Unit', app.core.unit),
          kv('Receive key', `${app.core.me.pub.slice(0, 10)}…`),
        ),
      ),
      h(
        'section',
        { class: 'section card danger-zone', 'aria-labelledby': 'set-reset' },
        h('h2', { class: 'tag t-bad', id: 'set-reset' }, '[ Reset ]'),
        h(
          'p',
          null,
          'Deletes everything on this device: ',
          h('strong', null, moneyText(hold.proofs)),
          hold.deposits ? `, ${plural(hold.deposits, 'add-money payment')} in progress (a paid one would be lost)` : '',
          hold.withdrawals ? `, ${plural(hold.withdrawals, 'cash-out')} in progress` : '',
          hold.offline ? `, ${moneyText(hold.offline)} received offline` : '',
          '. It can’t be undone: download a backup first.',
        ),
        field('Type RESET to confirm', confirmInput),
        resetBtn,
      ),
    );
    return { el };
  },
};
