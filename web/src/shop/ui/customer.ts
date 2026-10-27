// What a customer sees from a link, even with the shop offline: the invoice (#/invoice/<data>)
// with Pay with this wallet and the payment code for other wallets, and the receipt
// (#/receipt/<data>). Both check the shop's signature and warn when it doesn't match.
import { decodePaymentRequest } from '@cashu/cashu-ts';
import { busy, h } from '../../ui/dom';
import { backupNudge } from '../../ui/flows';
import { qrCard } from '../../ui/qr';
import { kv, moneyEl, pageHead, resultView, waiting, type App, type Page } from '../../ui/widgets';
import { moneyText } from '../../ui/words';
import { CANCELLED, EXPIRED } from '../../wallet/posreq';
import { unpack, type InvoiceDoc, type ReceiptDoc, type ShopInfo } from '../link';
import { savePurchase } from '../store';
import { linesTable, totalsBlock, when } from './common';

const shopBlock = (s: ShopInfo) =>
  h('div', { class: 'cust-shopinfo' }, h('strong', null, s.name), s.address ? h('span', null, s.address) : null, s.contact ? h('span', null, s.contact) : null, s.taxId ? h('span', null, `Tax/VAT no. ${s.taxId}`) : null);

const warning = (kind: string) =>
  h('p', { class: 'sig-warn', role: 'alert' }, `This ${kind}’s signature doesn’t match its contents: it may have been changed. Don’t pay or rely on it unless you trust where it came from.`);

/** "paid" / "open" from the payment service, or null if it can't be reached. */
async function serverState(creq: string): Promise<{ paid: boolean; expired: boolean; cancelled: boolean } | null> {
  try {
    const id = decodePaymentRequest(creq).id;
    const res = await fetch(`${location.origin}/pos/check/${encodeURIComponent(id ?? '')}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { state?: string; expired?: boolean; cancelled?: boolean };
    return { paid: body.state === 'PAID', expired: !!body.expired, cancelled: !!body.cancelled };
  } catch {
    return null;
  }
}

export const customerInvoicePage: Page = {
  title: 'Invoice',
  render(app, route) {
    const body = h('div', { class: 'flow' }, h('div', { class: 'working' }, waiting('Opening the invoice…')));
    const data = route.params.get('d') ?? '';
    void unpack<InvoiceDoc>('invoice', data).then(
      ({ doc, valid }) => body.replaceChildren(...invoiceView(app, doc, valid, data)),
      (e) => body.replaceChildren(resultView({ ok: false, title: 'Can’t open this invoice', text: app.explain(e) })),
    );
    return { el: h('div', { class: 'page wide' }, pageHead('Invoice'), body) };
  },
};

function invoiceView(app: App, d: InvoiceDoc, valid: boolean, data: string): Array<Node | string> {
  const expired = !!d.expiresAt && Date.now() > d.expiresAt;
  const status = h('p', { class: 'cust-status' }, waiting('Checking…'));
  const payBox = h('div', { class: 'stack' });
  const pay = h('button', { type: 'button', class: 'btn primary block big', disabled: expired }, `Pay ${moneyText(d.totals.total)} with this wallet`);
  const short = app.core.balance() < d.totals.total;
  pay.onclick = () => {
    const yes = h('button', { type: 'button', class: 'btn primary block' }, `Yes, pay ${moneyText(d.totals.total)}`);
    yes.onclick = () =>
      void busy(
        yes,
        async () => {
          const { item, ok, message } = await app.tokens.payRequest(d.creq);
          if (ok) savePurchase(app.core, { kind: 'invoice', number: d.number, shop: d.shop.name, total: d.totals.total, data, tokenId: item.id });
          payBox.replaceChildren(
            ok
              ? resultView({ ok: true, title: 'Paid', zat: item.amount, sign: '−', text: message === 'EXTRA' ? 'This invoice was already paid, so the shop got this as an extra payment; they can refund it.' : `${d.number} · ${d.shop.name}. Saved in your Activity.`, extra: backupNudge(app) })
              : resultView({ ok: false, title: 'Not delivered yet', text: `${app.explain(new Error(message))} The payment is saved in your Activity; try again from there.`, actions: [h('a', { href: `#/send?t=${encodeURIComponent(item.id)}`, class: 'btn primary block' }, 'Open the payment')] }),
          );
        },
        (e) => {
          const m = e instanceof Error ? e.message : '';
          if (m !== EXPIRED && m !== CANCELLED) return app.explain(e);
          payBox.replaceChildren(resultView({ ok: false, title: m === EXPIRED ? 'This invoice has expired' : 'This invoice was cancelled', text: m }));
          return '';
        },
      );
    payBox.replaceChildren(h('div', { class: 'confirm' }, h('p', { class: 'confirm-label' }, `Pay ${d.shop.name}`), moneyEl(d.totals.total, { cls: 'confirm-money' }), yes, h('button', { type: 'button', class: 'btn ghost block', onclick: () => payBox.replaceChildren(pay) }, 'Cancel')));
  };
  payBox.append(pay);
  if (short && !expired) payBox.append(h('p', { class: 'hint' }, `You have ${moneyText(app.core.balance())}. `, h('a', { href: '#/deposit' }, 'Add money'), ' first, or pay with another wallet below.'));
  if (expired) status.replaceChildren(h('span', { class: 't-bad' }, `Expired ${when(d.expiresAt)}`));
  else
    void serverState(d.creq).then((s) => {
      if (!s) status.replaceChildren(h('span', { class: 't-muted' }, 'Status unknown: the shop’s payment service can’t be reached. You can still pay; it’s delivered when it is back.'));
      else if (s.paid) {
        status.replaceChildren(h('span', { class: 't-ok' }, 'Paid'));
        pay.disabled = true;
      } else if (s.cancelled || s.expired) {
        status.replaceChildren(h('span', { class: 't-bad' }, s.cancelled ? 'Cancelled by the shop' : `Expired ${when(d.expiresAt)}`));
        pay.disabled = true;
      } else status.replaceChildren(h('span', { class: 't-live' }, `Waiting for payment · due ${when(d.expiresAt)}`));
    });
  return [
    valid ? '' : warning('invoice'),
    h(
      'section',
      { class: 'card inv-sum' },
      h('div', { class: 'sum-top' }, shopBlock(d.shop), h('div', { class: 'inv-no' }, h('span', { class: 'tag' }, 'Invoice'), h('strong', { class: 'mono' }, d.number))),
      d.customer ? kv('For', d.customer) : null,
      kv('Issued', when(d.issuedAt)),
      d.expiresAt ? kv(d.kind === 'sent' ? 'Pay by' : 'Expires', when(d.expiresAt)) : null,
      status,
    ),
    h('section', { class: 'card' }, linesTable(d.lines), totalsBlock(d.totals, d.taxRate, d.taxIncluded), d.note ? h('p', { class: 'hint' }, d.note) : null),
    expired ? '' : payBox,
    expired ? '' : h('section', { class: 'card stack center' }, h('p', { class: 'hint' }, 'Paying with another wallet? Scan this:'), qrCard(d.creq, { label: `Payment code for ${d.number}`, ecc: 'M' })),
    d.shop.footer ? h('p', { class: 'hint center' }, d.shop.footer) : '',
  ];
}

export const customerReceiptPage: Page = {
  title: 'Receipt',
  render(app, route) {
    const body = h('div', { class: 'flow' }, h('div', { class: 'working' }, waiting('Opening the receipt…')));
    const data = route.params.get('d') ?? '';
    void unpack<ReceiptDoc>('receipt', data).then(
      ({ doc, valid }) => {
        const save = h('button', { type: 'button', class: 'btn primary block' }, 'Save to my Activity');
        save.onclick = () => {
          savePurchase(app.core, { kind: 'receipt', number: doc.number, shop: doc.shop.name, total: doc.paid, data });
          save.replaceWith(h('p', { class: 't-ok center' }, 'Saved in your Activity.'));
        };
        body.replaceChildren(
          valid ? '' : warning('receipt'),
          h('section', { class: 'card inv-sum' }, h('div', { class: 'sum-top' }, shopBlock(doc.shop), h('div', { class: 'inv-no' }, h('span', { class: 'tag' }, 'Receipt'), h('strong', { class: 'mono' }, doc.number))), kv('Paid', when(doc.paidAt)), h('div', { class: 'kv total' }, h('span', null, 'Amount paid'), moneyEl(doc.paid, { cls: 'total-money' }))),
          h('section', { class: 'card' }, linesTable(doc.lines), totalsBlock(doc.totals, doc.taxRate, doc.taxIncluded)),
          valid ? save : '',
          doc.shop.footer ? h('p', { class: 'hint center' }, doc.shop.footer) : '',
        );
      },
      (e) => body.replaceChildren(resultView({ ok: false, title: 'Can’t open this receipt', text: app.explain(e) })),
    );
    return { el: h('div', { class: 'page wide' }, pageHead('Receipt'), body) };
  },
};
