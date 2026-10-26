// What happens after a code is scanned or pasted, wherever that was (Scan, Send, Receive):
// money for you -> receive; a payment code -> pay it; someone's receive code -> send to it,
// locked; a Zcash address -> Cash out, prefilled. The confirmations and the big result screens
// live here, plus the backup download that the first-run screen, Home and Settings offer.
import { getTokenMetadata } from '@cashu/cashu-ts';
import { makeBackup } from '../wallet/backup';
import { readRequest } from '../wallet/posreq';
import { classify, UNKNOWN_CODE } from './classify';
import { busy, copyChip, h, svg, toast, ICON } from './dom';
import { handOff } from './handoff';
import { go } from './router';
import { scanQr } from './scanner';
import { amountEntry, details, kv, moneyEl, resultView, waiting, type App } from './widgets';
import { moneyText } from './words';

/** Where a flow draws: the page swaps its content for `view`; `restart` brings back its start. */
export type Ctx = {
  app: App;
  show(view: Node): void;
  restart(): void;
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The primary "Scan their code" button, a small "Paste instead" link, and the paste box it opens.
 * `onText` gets whatever was read; `say` shows a line under the button (unknown code, no camera).
 */
export function scanBlock(opts: { label: string; prompt: string; primary?: boolean; onText: (text: string) => void }) {
  const msg = h('p', { class: 'inline-msg t-bad', role: 'alert' });
  const area = h('textarea', { class: 'input mono', rows: '3', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Code', placeholder: 'Paste the code here' });
  const cont = h('button', { type: 'submit', class: 'btn primary block' }, 'Continue');
  const box = h(
    'form',
    {
      class: 'paste-box',
      hidden: true,
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        if (!area.value.trim()) return say('Paste a code first.');
        opts.onText(area.value);
      },
    },
    area,
    cont,
  );
  // A paste is the whole code: go on without another tap.
  area.addEventListener('paste', () => setTimeout(() => area.value.trim() && box.requestSubmit(), 0));
  const openPaste = () => {
    box.hidden = false;
    area.focus();
  };
  const say = (text: string) => (msg.textContent = text);
  const scan = h('button', { type: 'button', class: `btn block big ${opts.primary === false ? '' : 'primary'}` }, svg(ICON.scan), opts.label);
  scan.onclick = async () => {
    say('');
    const r = await scanQr(opts.prompt);
    if (!r) return;
    if ('text' in r) opts.onText(r.text);
    else if ('paste' in r) openPaste();
    else {
      say(r.error);
      openPaste();
    }
  };
  const paste = h('button', { type: 'button', class: 'link-btn' }, 'Paste instead');
  paste.onclick = openPaste;
  const el = h('div', { class: 'scan-block' }, scan, h('div', { class: 'center' }, paste), msg, box);
  return { el, scan, say, openPaste };
}

/** Does the right thing with a code. `where`: on Receive, money is taken without asking again. */
export function handleCode(ctx: Ctx, text: string, where: 'scan' | 'send' | 'receive', say: (msg: string) => void) {
  const code = classify(text);
  switch (code.kind) {
    case 'token':
      return where === 'receive' ? receiveNow(ctx, code.text) : ctx.show(receiveConfirm(ctx, code.text));
    case 'request':
      return ctx.show(payConfirm(ctx, code.text));
    case 'pubkey':
      return ctx.show(lockedSend(ctx, code.text, null));
    case 'address':
      handOff('/withdraw', code.text);
      return go('/withdraw');
    default:
      say(UNKNOWN_CODE);
  }
}

const cancelBtn = (ctx: Ctx) => h('button', { type: 'button', class: 'btn ghost', onclick: () => ctx.restart() }, 'Cancel');

/** Someone's payment code: how much, for what, and Pay. */
export function payConfirm(ctx: Ctx, creq: string): Node {
  const { app } = ctx;
  let info;
  try {
    info = readRequest(creq, app.core.mintUrl, app.core.unit);
  } catch (e) {
    return resultView({ ok: false, title: 'Can’t pay this code', text: app.explain(e), actions: [h('button', { type: 'button', class: 'btn primary block', onclick: () => ctx.restart() }, 'Try another code')] });
  }
  const balance = app.core.balance();
  const short = balance < info.amount;
  const pay = h('button', { type: 'button', class: 'btn primary block big', disabled: short }, `Pay ${moneyText(info.amount)}`);
  pay.onclick = () =>
    void busy(
      pay,
      async () => {
        const { item, ok, message } = await app.tokens.payRequest(creq);
        go(`/send?t=${encodeURIComponent(item.id)}&r=${encodeURIComponent(ok ? message : 'FAILED')}`, true);
      },
      app.explain,
    );
  return h(
    'section',
    { class: 'confirm' },
    h('p', { class: 'confirm-label' }, 'Pay this code'),
    moneyEl(info.amount, { cls: 'confirm-money' }),
    info.description ? h('p', { class: 'confirm-desc' }, `“${info.description}”`) : null,
    short ? h('p', { class: 'field-err' }, `You have ${moneyText(balance)}. Add money first.`) : null,
    short ? h('a', { href: '#/deposit', class: 'btn block' }, 'Add money') : null,
    h('div', { class: 'confirm-actions' }, pay, cancelBtn(ctx)),
    details(
      kv('Paid to', host(info.target)),
      info.lockTo ? kv('Locked to', copyChip(info.lockTo, 'Key', 8, 6)) : kv('Lock', 'none'),
      h('p', { class: 'hint' }, 'A NUT-18 payment request. The ecash is locked to the payee’s key (P2PK) with DLEQ proofs, no refund or locktime, and delivered to their payment service.'),
    ),
  );
}

/** Someone's receive code (a public key): an amount, a warning, and Send. */
export function lockedSend(ctx: Ctx, pubkey: string, preset: number | null): Node {
  const { app } = ctx;
  const amount = amountEntry({ max: () => app.core.balance(), autofocus: preset === null });
  if (preset) amount.set(preset);
  const send = h('button', { type: 'submit', class: 'btn primary block big' }, 'Send');
  return h(
    'form',
    {
      class: 'confirm',
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        let zat: number | null;
        try {
          zat = amount.zat();
        } catch {
          return;
        }
        void busy(
          send,
          async () => {
            const item = await app.tokens.send(zat!, { compact: false, lockTo: pubkey });
            go(`/send?t=${encodeURIComponent(item.id)}`, true);
          },
          app.explain,
        );
      },
    },
    h('p', { class: 'confirm-label' }, 'Send to this person'),
    amount.el,
    h('p', { class: 'warn-line' }, 'Only they can take this money. You can’t take it back.'),
    h('div', { class: 'confirm-actions' }, send, cancelBtn(ctx)),
    details(kv('Their key', copyChip(pubkey, 'Key', 8, 6)), h('p', { class: 'hint' }, 'Locked to their public key (P2PK), with DLEQ proofs, so they can accept it even offline.')),
  );
}

/** Money someone shows you, from the universal Scan: how much, and Receive. */
export function receiveConfirm(ctx: Ctx, token: string): Node {
  const { app } = ctx;
  let amount: number;
  let mint: string;
  let unit: string;
  try {
    const meta = getTokenMetadata(token);
    amount = Number(String(meta.amount));
    mint = meta.mint;
    unit = meta.unit ?? 'sat';
  } catch {
    return resultView({ ok: false, title: 'Can’t read this code', text: 'It may be cut off. Ask them to show it again.', actions: [h('button', { type: 'button', class: 'btn primary block', onclick: () => ctx.restart() }, 'Scan again')] });
  }
  const take = h('button', { type: 'button', class: 'btn primary block big' }, 'Receive');
  take.onclick = () => receiveNow(ctx, token);
  return h(
    'section',
    { class: 'confirm' },
    h('p', { class: 'confirm-label' }, 'Money for you'),
    moneyEl(amount, { sign: '+', cls: 'confirm-money' }),
    h('div', { class: 'confirm-actions' }, take, cancelBtn(ctx)),
    details(kv('From', host(mint)), kv('Unit', unit), h('p', { class: 'hint' }, 'A Cashu token (bearer ecash): whoever redeems it first gets the money.')),
  );
}

/** Takes the money now: "Receiving…", then a big +X or a plain reason and Try again. */
export async function receiveNow(ctx: Ctx, token: string) {
  const { app } = ctx;
  ctx.show(h('div', { class: 'working', role: 'status' }, waiting('Receiving…')));
  try {
    const r = await app.tokens.receive(token);
    ctx.show(
      resultView({
        ok: true,
        title: 'Received',
        zat: r.amount,
        sign: '+',
        text: r.offline ? 'Received offline. It’s confirmed by itself when you’re back online.' : undefined,
        extra: backupNudge(app),
      }),
    );
  } catch (e) {
    ctx.show(resultView({ ok: false, title: 'Couldn’t receive', text: app.explain(e), actions: [h('button', { type: 'button', class: 'btn primary block', onclick: () => ctx.restart() }, 'Try again')] }));
  }
}

/** Saves the backup file (everything this browser holds for the mint) and remembers when. */
export function downloadBackup(app: App) {
  const network = app.core.mainnet ? 'mainnet' : 'regtest';
  app.prefs.set({ backupAt: Date.now() }); // first, so the file says it is backed up
  const b = makeBackup(app.core.mintUrl, network);
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `zec-ecash-${network}-backup-${b.createdAt.slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup saved. Keep the file private: whoever has it can spend your money.', 'ok');
}

/** After money arrives, until there is a backup: one line and a button. */
export function backupNudge(app: App, onDone?: () => void): HTMLElement | null {
  if (app.prefs.get().backupAt) return null;
  const btn = h('button', { type: 'button', class: 'btn' }, 'Back up now');
  const el = h('div', { class: 'nudge', role: 'note' }, h('p', null, 'Your money lives only on this device. Back it up so you can’t lose it.'), btn);
  btn.onclick = () => {
    downloadBackup(app);
    el.remove();
    onDone?.();
  };
  return el;
}
