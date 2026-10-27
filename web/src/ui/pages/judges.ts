// The judges' tour (#/judges): short steps, each with a "Do it" link to the right screen, one
// line on what is special about it, and a tick saved on this device. Linked from the claim
// screen and from Settings.
import { busy, h, svg, toast, ICON } from '../dom';
import { backupNudge } from '../flows';
import { qrCard } from '../qr';
import { go } from '../router';
import { moneyEl, pageHead, type App, type Page } from '../widgets';

export const REPO = 'https://github.com/guni7/zec-ecash';

type Step = { id: string; title: string; how: string; special: string; href?: string; extra?: (app: App) => Node | null };

const DEMO = { name: 'Demo Café', items: [['Coffee', 1000, 'Drinks'], ['Cake', 1500, 'Food']] as const };

/** "Load a demo shop": a sample profile and catalogue, then the counter. Never over a real shop. */
async function loadDemo(app: App) {
  const { shopFor } = await import('../../shop/open');
  const { DEFAULT_PROFILE } = await import('../../shop/model');
  const shop = await shopFor(app);
  if (shop.profile() && !app.prefs.get().demoShop) throw new Error('This device already has a shop set up; the demo would replace it. Try it on another device.');
  await shop.setProfile({ ...DEFAULT_PROFILE, name: DEMO.name, footer: 'Thanks for trying zec-ecash!' });
  if (!shop.items().length) for (const [name, price, category] of DEMO.items) await shop.saveItem({ name, price, category });
  app.prefs.set({ demoShop: true });
  app.setShopMode(true);
}

/** "Leave demo shop": the demo's profile, catalogue and invoices go; the money stays. */
async function leaveDemo(app: App) {
  const { shopFor } = await import('../../shop/open');
  await (await shopFor(app)).wipe();
  app.prefs.set({ demoShop: false });
  app.setShopMode(false);
  go('/judges', true);
}

const STEPS: Step[] = [
  { id: 'balance', title: 'Look at your balance', how: 'Home shows it in zats, with ZEC underneath.', special: 'It’s ecash: held on this device, not in an account. No sign-up, no email.', href: '#/' },
  {
    id: 'second',
    title: 'Send to yourself on a second device',
    how: 'Open the wallet on another device (scan this), then here: Send → Show a code, and scan it from the other device.',
    special: 'The code is the money itself: whoever scans it first takes it, like handing over cash.',
    href: '#/send?do=show',
    extra: () => h('div', { class: 'tour-qr' }, qrCard(`${location.origin}/`, { label: 'Open the wallet on another device', caption: 'Open the wallet on another device' })),
  },
  {
    id: 'offline',
    title: 'Receive without internet',
    how: 'Put the receiving phone in airplane mode, open Receive → Receive without internet, and pay it from the other device (Send → Send without internet, scan its code, then scan back).',
    special: 'The receiver had no internet. Only their phone can spend this: it’s locked to their key and the mint’s signature is checked on the spot.',
    href: '#/receive?do=without',
  },
  {
    id: 'request',
    title: 'Ask for an amount',
    how: 'Receive → Request an amount, then pay it from the other device by scanning.',
    special: 'The payment lands straight in this wallet, locked to a key used once; the payment service never holds the money.',
    href: '#/receive?do=request',
  },
  {
    id: 'shop',
    title: 'Try shop mode',
    how: 'Load the demo shop, charge a sale (pay it from the other device), then open the invoice and export the receipt PDF.',
    special: 'A counter, invoices, signed receipts and sales figures, all on the device, paid in ZEC from any wallet.',
    extra: (app) => {
      const load = h('button', { type: 'button', class: 'btn' }, svg(ICON.shop), 'Load a demo shop');
      load.onclick = () => void busy(load, () => loadDemo(app), app.explain);
      const leave = h('button', { type: 'button', class: 'btn ghost' }, 'Leave demo shop');
      leave.onclick = () => void busy(leave, () => leaveDemo(app), app.explain);
      return h('div', { class: 'row wrap' }, app.prefs.get().demoShop ? leave : load, h('span', { class: 'hint' }, `${DEMO.name}: coffee 1,000 zats, cake 1,500 zats.`));
    },
  },
  { id: 'status', title: 'Check the backing', how: 'Is my money safe? compares the ZEC the mint holds on chain with all the ecash it has issued.', special: 'The reserve sits behind keys split between three keyholders: no single one can move it.', href: '#/status' },
  { id: 'cashout', title: 'Cash out to Zcash (optional)', how: 'If you have a Zcash wallet: Cash out at least 10,000 zats to its address (scan it).', special: 'Ecash turns back into real ZEC on chain, sent to any Zcash address.', href: '#/withdraw' },
  { id: 'deposit', title: 'Have ZEC? Add money', how: 'Add money: send ZEC from any Zcash wallet to the address shown. It takes about 13 minutes; start it now and carry on.', special: 'ZEC in, ecash out, minted once the deposit has its confirmations.', href: '#/deposit' },
];

export const judges: Page = {
  title: 'Judges’ tour',
  render(app) {
    const key = app.core.key('judge-tour');
    const done = new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
    const progress = h('p', { class: 'tour-progress mono', 'aria-live': 'polite' });
    const count = () => (progress.textContent = `${done.size} of ${STEPS.length} done`);
    const list = h(
      'ol',
      { class: 'tour' },
      STEPS.map((s, i) => {
        const tick = h('input', { type: 'checkbox', class: 'tour-tick', id: `tour-${s.id}`, checked: done.has(s.id) });
        const item = h(
          'li',
          { class: `card tour-step ${done.has(s.id) ? 'done' : ''}`, 'data-step': s.id },
          h('div', { class: 'tour-head' }, h('label', { for: `tour-${s.id}`, class: 'tour-check' }, tick, h('span', { class: 'tour-n mono' }, String(i + 1).padStart(2, '0')), h('strong', null, s.title)), s.href ? h('a', { href: s.href, class: 'btn primary tour-do' }, 'Do it') : null),
          h('p', null, s.how),
          h('p', { class: 'tour-special' }, s.special),
          s.extra?.(app) ?? null,
        );
        tick.onchange = () => {
          if (tick.checked) done.add(s.id);
          else done.delete(s.id);
          localStorage.setItem(key, JSON.stringify([...done]));
          item.classList.toggle('done', tick.checked);
          count();
          if (done.size === STEPS.length) toast('All done. Thank you for judging!', 'ok');
        };
        return item;
      }),
    );
    count();
    const el = h(
      'div',
      { class: 'page' },
      pageHead('Judges’ tour', { back: true }),
      h('section', { class: 'card tour-top' }, h('span', { class: 'tag' }, '[ Your balance ]'), moneyEl(app.core.balance(), { cls: 'tour-balance' }), progress, h('p', { class: 'hint' }, 'Tick each step when you’ve done it; the ticks stay on this device.')),
      backupNudge(app) ?? '',
      list,
      h(
        'section',
        { class: 'card stack tour-end' },
        h('h2', { class: 'section-title' }, 'What you just saw'),
        h(
          'ul',
          { class: 'tour-summary' },
          h('li', null, 'Cashu ecash for Zcash: private, instant payments in zats, backed one-to-one by ZEC.'),
          h('li', null, 'Codes that are the money itself, payable without internet on the receiving side.'),
          h('li', null, 'Payment requests and a shop mode where the server never holds the money.'),
          h('li', null, 'A reserve you can check, guarded by keys split between three keyholders, and a way back to ZEC at any time.'),
        ),
        h('div', { class: 'row wrap' }, h('a', { href: `${REPO}#readme`, class: 'btn', target: '_blank', rel: 'noopener' }, svg(ICON.external), 'Project description'), h('a', { href: REPO, class: 'btn', target: '_blank', rel: 'noopener' }, svg(ICON.external), 'The code')),
      ),
    );
    const off = app.onChange(() => el.querySelector('.tour-balance')?.replaceWith(moneyEl(app.core.balance(), { cls: 'tour-balance' })));
    return { el, cleanup: off };
  },
};
