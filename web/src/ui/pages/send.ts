import type { SentToken } from '../../wallet/tokens';
import { ago, busy, copyChip, copyText, fmtZat, h, svg, toast, ICON } from '../dom';
import { qrCard } from '../qr';
import { go } from '../router';
import { scanQr } from '../scanner';
import { amountField, amountInput, field, glitch, pageHead, waiting, type App, type Page } from '../widgets';

export const send: Page = {
  title: 'Send',
  render(app, route) {
    const id = route.params.get('t');
    const token = id ? app.tokens.sent().find((s) => s.id === id) : undefined;
    if (id && token) return tokenView(app, token);
    return form(app);
  },
};

function form(app: App) {
  const amount = amountInput();
  const compact = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: app.core.settings().compact });
  const lock = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  const pubkey = h('textarea', { class: 'input mono', rows: '2', spellcheck: 'false', autocomplete: 'off', placeholder: '02… or 03… (66 hex characters)' });
  const scanBtn = h('button', { type: 'button', class: 'btn' }, svg(ICON.scan), 'Scan their key');
  const lockBox = h('div', { class: 'lock-box', hidden: true }, field("Recipient's public key", pubkey, 'Only the holder of this key can redeem the token, and they can accept it offline.'), scanBtn);
  const go_ = h('button', { type: 'submit', class: 'btn primary block' }, '[ CREATE TOKEN ]');
  const balance = h('p', { class: 'hint' });
  const showBalance = () => (balance.textContent = `Balance ${fmtZat(app.core.balance())} zat`);
  showBalance();

  lock.onchange = () => {
    lockBox.hidden = !lock.checked;
    compact.disabled = lock.checked;
    if (lock.checked) pubkey.focus();
  };
  scanBtn.onclick = async () => {
    const got = await scanQr("Point the camera at the recipient's public key");
    if (got) pubkey.value = got.trim();
  };

  const formEl = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        void busy(
          go_,
          async () => {
            const item = await app.tokens.send(Number(amount.value), { compact: compact.checked, lockTo: lock.checked ? pubkey.value : undefined });
            go(`/send?t=${encodeURIComponent(item.id)}`, true);
            toast(`Token for ${fmtZat(item.amount)} zat created. Whoever holds it can spend it: hand it over now.`, 'ok');
          },
          app.core.explain,
        );
      },
    },
    amountField('Amount', amount),
    balance,
    h('label', { class: 'toggle' }, compact, h('span', null, h('strong', null, 'Compact token'), h('small', null, "Smaller QR; the receiver can't verify it offline. Locked tokens are never compact."))),
    h('label', { class: 'toggle' }, lock, h('span', null, h('strong', null, 'Lock to recipient'), h('small', null, 'P2PK: only their key can redeem it.'))),
    lockBox,
    h('div', { class: 'thumb' }, go_),
  );

  const pending = app.tokens.sent().filter((s) => s.state === 'pending');
  const el = h(
    'div',
    { class: 'page' },
    pageHead('SEND', 'Send ecash', 'Make a token for an amount and hand it over as a QR code or text.'),
    formEl,
    pending.length
      ? h(
          'section',
          { class: 'section' },
          h('h3', { class: 'section-title' }, 'Not redeemed yet'),
          h(
            'div',
            { class: 'list' },
            pending.slice(0, 8).map((s) => h('a', { href: `#/send?t=${encodeURIComponent(s.id)}`, class: 'list-row' }, h('span', { class: 'mono' }, `${fmtZat(s.amount)} zat`), h('span', { class: 'hint' }, `${s.lockedTo ? 'locked · ' : ''}${ago(s.at)}`))),
          ),
        )
      : null,
  );
  return { el, cleanup: app.onChange(showBalance) };
}

function tokenView(app: App, s: SentToken) {
  const status = h('div', { class: 'status-line' });
  const actions = h('div', { class: 'row wrap' });
  let timer: ReturnType<typeof setInterval> | undefined;

  const render = () => {
    const cur = app.tokens.sent().find((x) => x.id === s.id) ?? s;
    status.replaceChildren(
      cur.state === 'pending' ? waiting('NOT REDEEMED YET') : cur.state === 'received' ? glitch('RECEIVED', 't-live') : h('span', { class: 't-muted' }, 'RECLAIMED'),
      h('span', { class: 'hint' }, ` · ${fmtZat(cur.amount)} zat · ${cur.lockedTo ? 'locked' : cur.compact ? 'compact' : 'with DLEQ'} · ${ago(cur.at)}`),
    );
    const btns: HTMLElement[] = [];
    if (cur.state === 'pending') {
      const check = h('button', { type: 'button', class: 'btn' }, 'Check now');
      check.onclick = () => void busy(check, async () => {
        const r = await app.tokens.refresh(cur.id);
        toast(r?.state === 'received' ? 'The recipient redeemed it.' : 'Not redeemed yet.', r?.state === 'received' ? 'ok' : '');
      }, app.core.explain);
      const mark = h('button', { type: 'button', class: 'btn' }, 'Mark received');
      mark.onclick = () => app.tokens.markReceived(cur.id);
      btns.push(check, mark);
      if (!cur.lockedTo) {
        const reclaim = h('button', { type: 'button', class: 'btn danger-outline' }, 'Reclaim');
        reclaim.onclick = () => {
          if (!confirm('Take this token back? It stops working for anyone who has it.')) return;
          void busy(reclaim, async () => toast(`Reclaimed ${fmtZat(await app.tokens.reclaim(cur.id))} zat.`, 'ok'), app.core.explain);
        };
        btns.push(reclaim);
      }
    }
    actions.replaceChildren(...btns);
  };
  render();
  if (s.state === 'pending') timer = setInterval(() => void app.tokens.refresh(s.id).catch(() => {}), 10_000);

  const share = 'share' in navigator ? h('button', { type: 'button', class: 'btn' }, svg(ICON.share), 'Share') : null;
  if (share) share.onclick = () => void navigator.share({ text: s.token }).catch(() => {});
  const copy = h('button', { type: 'button', class: 'btn primary' }, svg(ICON.copy), 'Copy token');
  copy.onclick = () => void copyText(s.token, 'Token');

  const el = h(
    'div',
    { class: 'page' },
    pageHead('TOKEN', `${fmtZat(s.amount)} zat`, s.lockedTo ? 'Locked to the recipient: only their key can redeem it.' : 'Spendable by whoever holds it until it is redeemed.'),
    status,
    qrCard(s.token, { label: `QR code of the ${s.amount} zat token`, ecc: 'L', caption: `${s.token.length} characters` }),
    h('div', { class: 'row wrap thumb-row' }, copy, share),
    s.lockedTo ? h('p', { class: 'hint' }, 'Locked to ', copyChip(s.lockedTo, 'Recipient key', 8, 6)) : null,
    h('details', { class: 'details' }, h('summary', null, 'Show token text'), h('textarea', { class: 'input mono', rows: '5', readonly: true, spellcheck: 'false', 'aria-label': 'Token text', value: s.token })),
    actions,
    h('a', { href: '#/send', class: 'btn block ghost' }, 'New token'),
  );
  const off = app.onChange(render);
  return {
    el,
    cleanup: () => {
      clearInterval(timer);
      off();
    },
  };
}
