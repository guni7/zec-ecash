import { createRequest, checkRequest } from '../../wallet/pos';
import { busy, copyText, fmtZat, h, svg, ICON } from '../dom';
import { qrCard } from '../qr';
import { amountField, amountInput, glitch, pageHead, waiting, type Page } from '../widgets';

export const request: Page = {
  title: 'Request',
  render(app) {
    const amount = amountInput();
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, '[ CREATE REQUEST ]');
    const out = h('div');
    let poll: ReturnType<typeof setInterval> | undefined;

    const el = h(
      'div',
      { class: 'page' },
      pageHead('REQUEST', 'Request payment', "A NUT-18 payment request from the point-of-sale server: the payer's wallet sends locked ecash straight to it, and this page shows when it's paid."),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: (e: SubmitEvent) => {
            e.preventDefault();
            void busy(
              submit,
              async () => {
                const r = await createRequest(Number(amount.value), app.core.unit, app.core.mainnet);
                const state = h('div', { class: 'status-line big' }, waiting('WAITING FOR PAYMENT'));
                out.replaceChildren(
                  h(
                    'section',
                    { class: 'section' },
                    state,
                    qrCard(r.request, { label: `QR code of a payment request for ${r.amount} zat`, ecc: 'M' }),
                    h('div', { class: 'row wrap thumb-row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => void copyText(r.request, 'Request') }, svg(ICON.copy), 'Copy request')),
                    h('details', { class: 'details' }, h('summary', null, 'Show request text'), h('textarea', { class: 'input mono', rows: '4', readonly: true, 'aria-label': 'Request text', value: r.request })),
                  ),
                );
                clearInterval(poll);
                poll = setInterval(async () => {
                  try {
                    const s = await checkRequest(r.id);
                    if (s.state === 'PAID') {
                      state.replaceChildren(glitch('PAID', 't-live'), h('span', { class: 'mono minted' }, ` ${fmtZat(s.received ?? r.amount)} zat`));
                      clearInterval(poll);
                    }
                  } catch {
                    /* transient; keep polling */
                  }
                }, 2000);
              },
              app.core.explain,
            );
          },
        },
        amountField('Amount', amount),
        h('div', { class: 'thumb' }, submit),
      ),
      out,
    );
    return { el, cleanup: () => clearInterval(poll) };
  },
};
