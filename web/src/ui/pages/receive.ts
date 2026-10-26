import { ago, busy, copyChip, fmtZat, h, svg, toast, ICON } from '../dom';
import { qrCard } from '../qr';
import { scanQr } from '../scanner';
import { field, pageHead, type Page } from '../widgets';

export const receive: Page = {
  title: 'Receive',
  render(app) {
    const input = h('textarea', { class: 'input mono', rows: '3', spellcheck: 'false', autocomplete: 'off', placeholder: 'cashuB…' });
    const redeem = h('button', { type: 'submit', class: 'btn primary block' });
    const scanBtn = h('button', { type: 'button', class: 'btn' }, svg(ICON.scan), 'Scan QR');
    const pendingBox = h('div');

    const label = () => {
      redeem.textContent = navigator.onLine && app.core.mintUp() !== false ? '[ REDEEM ]' : '[ ACCEPT OFFLINE ]';
    };
    const doReceive = (text: string) =>
      busy(
        redeem,
        async () => {
          const r = await app.tokens.receive(text);
          input.value = '';
          toast(r.offline ? `Accepted offline: ${fmtZat(r.amount)} zat, locked to this wallet with valid mint signatures. Redeems when online.` : `Received ${fmtZat(r.amount)} zat.`, 'ok');
        },
        app.core.explain,
      );
    scanBtn.onclick = async () => {
      const got = await scanQr('Point the camera at a token QR code');
      if (got) {
        input.value = got;
        void doReceive(got);
      }
    };

    const update = () => {
      label();
      const p = app.tokens.pendingOffline();
      pendingBox.replaceChildren(
        p.length
          ? h(
              'section',
              { class: 'section' },
              h('h3', { class: 'section-title' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'Accepted offline, not redeemed yet'),
              h('div', { class: 'list' }, p.map((x) => h('div', { class: 'list-row' }, h('span', { class: 'mono' }, `+${fmtZat(x.amount)} zat`), h('span', { class: 'hint' }, ago(x.at))))),
              h('p', { class: 'hint' }, 'They are redeemed automatically as soon as the mint is reachable.'),
            )
          : '',
      );
    };
    update();
    const onNet = () => label();
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);

    const el = h(
      'div',
      { class: 'page' },
      pageHead('RECEIVE', 'Receive ecash', 'Paste or scan a token. With no network, only tokens locked to your key (with DLEQ proofs) are accepted, and redeemed later.'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: (e: SubmitEvent) => {
            e.preventDefault();
            void doReceive(input.value);
          },
        },
        field('Token', input),
        h('div', { class: 'row' }, scanBtn),
        h('div', { class: 'thumb' }, redeem),
      ),
      pendingBox,
      h(
        'section',
        { class: 'section card' },
        h('span', { class: 'tag' }, '[ MY KEY ]'),
        h('h3', { class: 'section-title' }, 'Receive offline'),
        h('p', { class: 'hint' }, 'Show this key to the sender. A token they lock to it can be accepted here with no network and is redeemed once you are back online.'),
        qrCard(app.core.me.pub, { label: 'QR code of your public key', ecc: 'M' }),
        h('div', { class: 'center' }, copyChip(app.core.me.pub, 'Public key', 10, 8)),
      ),
    );
    const off = app.onChange(update);
    return {
      el,
      cleanup: () => {
        off();
        window.removeEventListener('online', onNet);
        window.removeEventListener('offline', onNet);
      },
    };
  },
};
