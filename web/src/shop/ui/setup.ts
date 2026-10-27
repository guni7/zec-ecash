// Settings › Shop: the shop profile (name, details, logo, numbering, tax, footer, expiries) and
// the catalogue (add, edit, archive). "Set up your shop" is the same page, the first time.
import { busy, h, svg, toast, ICON } from '../../ui/dom';
import { field, pageHead, type App, type Page } from '../../ui/widgets';
import { moneyText, parseAmount } from '../../ui/words';
import { DEFAULT_PROFILE, type Item, type Profile } from '../model';
import type { Shop } from '../store';

/** An uploaded image, scaled to fit 256 px, as a PNG data: URL (kept on this device). */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => ((img.onload = res), (img.onerror = () => rej(new Error('That file isn’t an image this browser can read.'))), (img.src = url)));
    const k = Math.min(1, 256 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const setupPage = (shop: Shop): Page => ({
  title: 'Shop',
  render(app, route) {
    const first = route.params.has('setup') || !shop.profile();
    return { el: h('div', { class: 'page wide' }, pageHead(first ? 'Set up your shop' : 'Shop', { back: true }), first ? h('p', { class: 'lead' }, 'Your shop’s details go on invoices and receipts. Only the name is needed; you can change everything later.') : '', h('div', { class: 'edit-grid' }, profileForm(app, shop, first), catalogue(app, shop))) };
  },
});

function profileForm(app: App, shop: Shop, first: boolean) {
  const p: Profile = { ...DEFAULT_PROFILE, ...(shop.profile() ?? {}) };
  const text = (v?: string | number, attrs: Record<string, unknown> = {}) => h('input', { type: 'text', class: 'input', value: v === undefined ? '' : String(v), autocomplete: 'off', ...attrs });
  const name = text(p.name, { required: true });
  const address = h('textarea', { class: 'input', rows: '2', value: p.address ?? '' });
  const taxId = text(p.taxId);
  const contact = text(p.contact);
  const prefix = text(p.prefix, { class: 'input mono' });
  const rate = text(p.taxRate ?? '', { inputmode: 'decimal', class: 'input mono', placeholder: 'none' });
  const incl = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: p.taxIncluded });
  const footer = text(p.footer);
  const counterMin = text(p.counterExpiryMin, { inputmode: 'numeric', class: 'input mono' });
  const sentDays = text(p.sentExpiryDays, { inputmode: 'numeric', class: 'input mono' });
  const autoRet = text(p.autoReturnSec, { inputmode: 'numeric', class: 'input mono' });
  let logo = p.logo;
  const logoImg = h('img', { class: 'logo-preview', alt: 'Shop logo', hidden: !logo, src: logo ?? '' });
  const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'visually-hidden', id: 'logo-file' });
  const dropLogo = h('button', { type: 'button', class: 'btn ghost', hidden: !logo }, 'Remove logo');
  logoFile.onchange = async () => {
    const f = logoFile.files?.[0];
    if (!f) return;
    try {
      logo = await shrink(f);
      logoImg.src = logo;
      logoImg.hidden = false;
      dropLogo.hidden = false;
    } catch (e) {
      toast(app.explain(e), 'bad');
    }
  };
  dropLogo.onclick = () => {
    logo = undefined;
    logoImg.hidden = true;
    dropLogo.hidden = true;
  };
  const err = h('p', { class: 'field-err', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'btn primary block' }, first ? 'Save and open the shop' : 'Save');
  const num = (el: HTMLInputElement, what: string, min: number) => {
    const n = Number(el.value.trim());
    if (!Number.isInteger(n) || n < min) throw new Error(`${what}: enter a whole number${min ? ` from ${min}` : ''}.`);
    return n;
  };
  const form = h(
    'form',
    {
      class: 'card stack',
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        void busy(
          save,
          async () => {
            err.textContent = '';
            if (!name.value.trim()) throw new Error('Enter the shop’s name.');
            const r = rate.value.trim() ? Number(rate.value.replace(',', '.')) : undefined;
            if (r !== undefined && !(r >= 0 && r < 100)) throw new Error('Tax rate: a percentage below 100.');
            await shop.setProfile({
              name: name.value.trim(),
              address: address.value.trim() || undefined,
              taxId: taxId.value.trim() || undefined,
              contact: contact.value.trim() || undefined,
              logo,
              prefix: prefix.value.trim() || 'INV-',
              taxRate: r || undefined,
              taxIncluded: incl.checked,
              footer: footer.value.trim() || undefined,
              counterExpiryMin: num(counterMin, 'Counter sales expire after', 1),
              sentExpiryDays: num(sentDays, 'Sent invoices are due after', 1),
              autoReturnSec: num(autoRet, 'Back to a new sale after', 0),
            });
            if (first) app.setShopMode(true);
            else toast('Shop saved.', 'ok');
          },
          (e) => (err.textContent = app.explain(e)),
        );
      },
    },
    h('h2', { class: 'tag' }, '[ Profile ]'),
    field('Shop name', name),
    field('Address (optional)', address),
    field('Tax/VAT number (optional)', taxId),
    field('Email or phone (optional)', contact),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Logo (optional)'), h('div', { class: 'row wrap' }, logoImg, h('label', { for: 'logo-file', class: 'btn' }, 'Choose an image…'), logoFile, dropLogo), h('p', { class: 'hint' }, 'Shown on invoices, receipts and PDFs. Not in invoice links, to keep them short.')),
    h('h2', { class: 'tag' }, '[ Invoices ]'),
    field('Number prefix', prefix, 'Numbers go INV-0001, INV-0002… and are never reused.'),
    field('Tax rate % (optional)', rate),
    h('label', { class: 'toggle' }, incl, h('span', null, h('strong', null, 'Prices include tax'))),
    field('Footer note', footer),
    field('Counter sales expire after (minutes)', counterMin),
    field('Sent invoices are due after (days)', sentDays),
    field('Paid screen: back to a new sale after (seconds, 0 to stay)', autoRet),
    err,
    save,
  );
  return form;
}

function catalogue(app: App, shop: Shop) {
  const box = h('section', { class: 'card stack' });
  const name = h('input', { type: 'text', class: 'input', placeholder: 'Name', 'aria-label': 'Item name' });
  const price = h('input', { type: 'text', inputmode: 'numeric', class: 'input mono', placeholder: 'Price (zats)', 'aria-label': 'Item price in zats' });
  const cat = h('input', { type: 'text', class: 'input', placeholder: 'Category (optional)', 'aria-label': 'Item category' });
  const err = h('p', { class: 'field-err', role: 'alert' });
  let editing: Item | null = null;
  const add = h('button', { type: 'submit', class: 'btn primary' }, svg(ICON.plus), 'Add item');
  const showArchived = h('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const items = shop.items().filter((i) => showArchived.checked || !i.archived);
    list.replaceChildren(
      ...(items.length
        ? items.map((i) => {
            const edit = h('button', { type: 'button', class: 'btn ghost' }, 'Edit');
            edit.onclick = () => {
              editing = i;
              name.value = i.name;
              price.value = String(i.price);
              cat.value = i.category ?? '';
              add.lastChild!.textContent = 'Save item';
              name.focus();
            };
            const arch = h('button', { type: 'button', class: 'btn ghost' }, i.archived ? 'Restore' : 'Archive');
            arch.onclick = () => void busy(arch, async () => void (await shop.saveItem({ ...i, archived: !i.archived })), app.explain);
            return h('div', { class: `list-row item-row ${i.archived ? 'archived' : ''}` }, h('span', null, h('strong', null, i.name), h('span', { class: 'hint' }, ` ${moneyText(i.price)}${i.category ? ` · ${i.category}` : ''}${i.archived ? ' · archived' : ''}`)), h('span', { class: 'row' }, edit, arch));
          })
        : [h('p', { class: 'hint' }, 'No items yet. The counter also takes typed amounts.')]),
    );
  };
  showArchived.onchange = draw;
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        void busy(
          add,
          async () => {
            err.textContent = '';
            if (!name.value.trim()) throw new Error('Enter the item’s name.');
            const p = parseAmount(price.value, 'zats');
            if (!p) throw new Error('Enter the price in zats.');
            await shop.saveItem({ ...(editing ?? {}), name: name.value.trim(), price: p, category: cat.value.trim() || undefined, archived: editing?.archived });
            editing = null;
            name.value = price.value = cat.value = '';
            add.lastChild!.textContent = 'Add item';
            name.focus();
          },
          (e) => (err.textContent = app.explain(e)),
        );
      },
    },
    h('div', { class: 'item-form' }, name, price, cat),
    err,
    add,
  );
  draw();
  shop.on(draw);
  box.append(h('h2', { class: 'tag' }, '[ Catalogue ]'), h('p', { class: 'hint' }, 'Optional: items to tap at the counter and add to invoices.'), form, list, h('label', { class: 'toggle' }, showArchived, h('span', null, h('strong', null, 'Show archived items'))));
  return box;
}
