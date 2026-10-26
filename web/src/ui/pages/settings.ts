import { getEncodedToken } from '@cashu/cashu-ts';
import { holdings, makeBackup, resetWallet, restoreBackup } from '../../wallet/backup';
import { copyText, fmtZat, h, plural, toast } from '../dom';
import { field, pageHead, type Page } from '../widgets';

export const settings: Page = {
  title: 'Settings',
  render(app) {
    const network = app.core.mainnet ? 'mainnet' : 'regtest';
    const compact = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: app.core.settings().compact });
    compact.onchange = () => {
      app.core.setSettings({ compact: compact.checked });
      toast(`New tokens are ${compact.checked ? 'compact' : 'sent with DLEQ proofs'} by default.`, 'ok');
    };

    const download = () => {
      const b = makeBackup(app.core.mintUrl, network);
      const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `zec-ecash-${network}-backup-${b.createdAt.slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Backup downloaded. It holds spendable ecash and your keys: keep it private.', 'ok');
    };
    const copyAll = () => {
      const proofs = app.core.proofs();
      if (!proofs.length) return toast('No ecash to export.', 'bad');
      void copyText(getEncodedToken({ mint: app.core.mintUrl, unit: app.core.unit, proofs }), 'All ecash as one token');
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
        toast(e instanceof Error ? e.message : String(e), 'bad');
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
    const kv = (k: string, v: string) => h('div', { class: 'kv' }, h('span', null, k), h('span', { class: 'mono' }, v));

    const el = h(
      'div',
      { class: 'page' },
      pageHead('SETTINGS', 'Settings'),
      h('section', { class: 'section card' }, h('span', { class: 'tag' }, '[ MINT ]'), kv('Mint URL', app.core.mintUrl), kv('Network', app.core.mainnet ? 'MAINNET (real ZEC)' : 'regtest (devnet)'), kv('Unit', app.core.unit), h('p', { class: 'hint' }, 'Fixed when this page was built; tokens name this mint.')),
      h('section', { class: 'section card' }, h('span', { class: 'tag' }, '[ SENDING ]'), h('label', { class: 'toggle' }, compact, h('span', null, h('strong', null, 'Compact tokens by default'), h('small', null, "Smaller QR codes, but the receiver can't verify them offline.")))),
      h(
        'section',
        { class: 'section card' },
        h('span', { class: 'tag' }, '[ BACKUP ]'),
        h('p', { class: 'hint' }, 'Ecash lives only in this browser. A backup file holds your spendable ecash, your keys and anything in progress: anyone with it can spend it.'),
        h('div', { class: 'row wrap' }, h('button', { type: 'button', class: 'btn primary', onclick: download }, 'Download backup'), h('button', { type: 'button', class: 'btn', onclick: copyAll }, 'Copy all ecash as a token')),
        h('div', { class: 'row wrap' }, h('label', { for: 'restore-file', class: 'btn' }, 'Restore from a backup…'), file),
        h('p', { class: 'hint' }, 'Restoring works only into an empty wallet.'),
      ),
      h(
        'section',
        { class: 'section card danger-zone' },
        h('span', { class: 'tag t-bad' }, '[ DANGER ZONE ]'),
        h('h3', { class: 'section-title' }, 'Reset this wallet'),
        h(
          'p',
          null,
          'Deletes everything this browser holds for this mint: ',
          h('strong', null, `${fmtZat(hold.proofs)} zat of ecash`),
          hold.deposits ? `, ${plural(hold.deposits, 'open deposit')} (a paid one would be lost)` : '',
          hold.withdrawals ? `, ${plural(hold.withdrawals, 'withdrawal')} in progress` : '',
          hold.offline ? `, ${fmtZat(hold.offline)} zat accepted offline` : '',
          ', and your keys. It cannot be undone. Download a backup first.',
        ),
        field('Type RESET to confirm', confirmInput),
        resetBtn,
      ),
    );
    return { el };
  },
};
