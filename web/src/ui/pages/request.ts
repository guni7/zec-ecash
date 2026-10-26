import { createRequest, checkRequest, posOnline, PosOfflineError, POS_OFFLINE } from '../../wallet/pos';
import { busy, copyText, fmtZat, h, svg, ICON } from '../dom';
import { qrCard } from '../qr';
import { amountField, amountInput, glitch, pageHead, waiting, type Page } from '../widgets';

export const request: Page = {
  title: 'Request',
  render(app) {
    const amount = amountInput();
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, '[ CREATE REQUEST ]');
    const offline = h('div', { class: 'pos-offline', role: 'status', hidden: true }, h('strong', null, 'Point of sale is offline'), h('p', null, 'Payment requests can’t be created right now. This page checks again by itself.'));
    const out = h('div');
    let poll: ReturnType<typeof setInterval> | undefined;
    let up: boolean | null = null;

    /** Offline: say so and disable Create request (an open request keeps its QR). */
    const setUp = (v: boolean) => {
      up = v;
      offline.hidden = v;
      submit.disabled = !v;
      submit.setAttribute('aria-disabled', String(!v));
    };
    const probe = async () => setUp(await posOnline());
    submit.disabled = true; // until the first health check answers
    void probe();
    const health = setInterval(() => void probe(), 15_000);

    const el = h(
      'div',
      { class: 'page' },
      pageHead('REQUEST', 'Request payment', "A NUT-18 payment request from the point-of-sale server: the payer's wallet sends locked ecash straight to it, and this page shows when it's paid."),
      offline,
      h(
        'form',
        {
          class: 'stack',
          onsubmit: (e: SubmitEvent) => {
            e.preventDefault();
            if (up === false) return;
            void busy(
              submit,
              async () => {
                let r;
                try {
                  r = await createRequest(Number(amount.value), app.core.unit);
                } catch (e) {
                  if (e instanceof PosOfflineError) setUp(false);
                  throw e;
                }
                const state = h('div', { class: 'status-line big' }, waiting('WAITING FOR PAYMENT'));
                const note = h('p', { class: 'hint center' });
                out.replaceChildren(
                  h(
                    'section',
                    { class: 'section' },
                    qrCard(r.request, { label: `QR code of a payment request for ${r.amount} zat`, ecc: 'M' }),
                    h('div', { class: 'row wrap thumb-row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => void copyText(r.request, 'Request') }, svg(ICON.copy), 'Copy request')),
                    state,
                    note,
                    h('details', { class: 'details' }, h('summary', null, 'Show request text'), h('textarea', { class: 'input mono', rows: '4', readonly: true, 'aria-label': 'Request text', value: r.request })),
                  ),
                );
                clearInterval(poll);
                poll = setInterval(async () => {
                  try {
                    const s = await checkRequest(r.id);
                    note.textContent = '';
                    if (s.state === 'PAID') {
                      state.replaceChildren(glitch('PAID', 't-live'), h('span', { class: 'mono minted' }, ` ${fmtZat(s.received ?? r.amount)} zat`));
                      clearInterval(poll);
                    }
                  } catch (e) {
                    // Keep polling: a payment made while it was down is retried by the payer.
                    if (e instanceof PosOfflineError) note.textContent = `${POS_OFFLINE.split('.')[0]}: still checking…`;
                  }
                }, 2000);
              },
              app.core.explain,
            ).then(() => up === false && setUp(false)); // busy() re-enables the button; offline wins
          },
        },
        amountField('Amount', amount),
        h('div', { class: 'thumb' }, submit),
      ),
      out,
    );
    return {
      el,
      cleanup: () => {
        clearInterval(poll);
        clearInterval(health);
      },
    };
  },
};
