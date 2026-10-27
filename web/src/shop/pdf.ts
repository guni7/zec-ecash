// PDFs made in the browser (works offline): the invoice (A4), the receipt (A4 or 80 mm thermal
// width) and the sales report (A4). pdf-lib is imported only from here, and this module only when
// someone exports, so nobody else downloads it. Standard PDF fonts (Helvetica) cover Western
// European text; other characters are replaced, so names in other scripts show as "?".
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { zatToZec } from '../wallet/onchain';
import type { InvoiceDoc, ReceiptDoc } from './link';
import { STATE_LABEL, type Row, type State } from './model';

const INK = rgb(0.07, 0.07, 0.08);
const GREY = rgb(0.38, 0.4, 0.43);
const LINE = rgb(0.82, 0.83, 0.85);
const GOLD = rgb(0.96, 0.72, 0.16);
const MM = 72 / 25.4;

/** WinAnsi only: curly quotes, dashes and arrows to plain ones; anything else outside it to "?". */
export function winAnsi(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/✓/g, '')
    .replace(/[^\x20-\x7e\xa0-\xff€–—•™]/g, '?');
}

const group = new Intl.NumberFormat('en-US');
const zats = (n: number) => `${group.format(n)} zats`;
const zec = (n: number) => `${zatToZec(n)} ZEC`;
const date = (t?: number) => (t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

class Sheet {
  y: number;
  constructor(
    public page: PDFPage,
    public f: PDFFont,
    public b: PDFFont,
    public margin: number,
  ) {
    this.y = page.getHeight() - margin;
  }
  get width() {
    return this.page.getWidth() - 2 * this.margin;
  }
  text(s: string, x: number, size = 10, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean; y?: number } = {}) {
    const font = opts.bold ? this.b : this.f;
    const t = winAnsi(s);
    const w = font.widthOfTextAtSize(t, size);
    this.page.drawText(t, { x: opts.right ? x - w : x, y: opts.y ?? this.y, size, font, color: opts.color ?? INK });
    return w;
  }
  /** Lines of `s` that fit `width`. */
  wrap(s: string, width: number, size = 10, bold = false): string[] {
    const font = bold ? this.b : this.f;
    const out: string[] = [];
    for (const para of winAnsi(s).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  para(s: string, x: number, width: number, size = 10, color = INK) {
    for (const l of this.wrap(s, width, size)) {
      this.text(l, x, size, { color });
      this.y -= size + 3;
    }
  }
  rule(color = LINE) {
    this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.margin + this.width, y: this.y }, thickness: 0.7, color });
  }
}

async function qrImage(pdf: PDFDocument, text: string): Promise<PDFImage> {
  const url = await QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 4, scale: 6, color: { dark: '#0b0c0eff', light: '#ffffffff' } });
  return pdf.embedPng(url);
}

async function logoImage(pdf: PDFDocument, logo?: string): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return /^data:image\/png/.test(logo) ? await pdf.embedPng(logo) : await pdf.embedJpg(logo);
  } catch {
    return null;
  }
}

async function start(title: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('zec-ecash wallet');
  pdf.setProducer('zec-ecash wallet (pdf-lib)');
  return { pdf, f: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold) };
}

/** Shop name and details at the top left (logo first, if any); returns the y below them. */
function shopHead(s: Sheet, shop: InvoiceDoc['shop'], logo: PDFImage | null, size = 18) {
  if (logo) {
    // the logo's top level with the name's cap height; the name goes below it
    const h = 44;
    const w = Math.min(140, (logo.width / logo.height) * h);
    s.page.drawImage(logo, { x: s.margin, y: s.y + size * 0.72 - h, width: w, height: h });
    s.y -= h - size * 0.72 + size * 0.72 + 8;
  }
  s.text(shop.name, s.margin, size, { bold: true });
  s.y -= size * 0.6 + 6;
  for (const l of [shop.address, shop.contact, shop.taxId ? `Tax/VAT no. ${shop.taxId}` : undefined].filter(Boolean) as string[]) {
    s.para(l, s.margin, s.width * 0.55, 9, GREY);
  }
}

/** Items table and totals. Amounts in zats with ZEC underneath. */
function itemsTable(s: Sheet, d: Pick<InvoiceDoc, 'lines' | 'totals' | 'taxRate' | 'taxIncluded'>, compact = false) {
  const x = s.margin;
  const right = s.margin + s.width;
  const qtyX = compact ? right - 95 : right - 190;
  const unitX = right - 95;
  s.y -= 6;
  s.text('Item', x, 8.5, { bold: true, color: GREY });
  if (!compact) {
    s.text('Qty', qtyX, 8.5, { bold: true, color: GREY, right: true });
    s.text('Unit price', unitX, 8.5, { bold: true, color: GREY, right: true });
  }
  s.text('Amount', right, 8.5, { bold: true, color: GREY, right: true });
  s.y -= 6;
  s.rule();
  s.y -= 13;
  for (const l of d.lines) {
    // narrow (80 mm): the name, the amount at the right, then "qty x price" on the next line
    const desc = s.wrap(l.desc, (compact ? right - 60 : qtyX - 40) - x, 9.5);
    s.text(desc[0], x, 9.5);
    if (!compact) {
      s.text(String(l.qty), qtyX, 9.5, { right: true });
      s.text(group.format(l.unit), unitX, 9.5, { right: true });
    }
    s.text(group.format(Math.round(l.qty * l.unit)), right, 9.5, { right: true });
    for (const more of desc.slice(1)) {
      s.y -= 12;
      s.text(more, x, 9.5);
    }
    if (compact) {
      s.y -= 11;
      s.text(`${l.qty} x ${group.format(l.unit)}`, x, 8, { color: GREY });
    }
    s.y -= 16;
  }
  s.rule();
  s.y -= 15;
  const t = d.totals;
  const label = (k: string, v: string, bold = false, size = 9.5) => {
    if (compact) s.text(k, x, size, { bold, color: bold ? INK : GREY });
    else s.text(k, unitX, size, { bold, color: bold ? INK : GREY, right: true });
    s.text(v, right, size, { bold, right: true });
    s.y -= size + 6;
  };
  if (d.taxRate) {
    label('Subtotal', zats(t.subtotal));
    label(`Tax ${d.taxRate}%${d.taxIncluded ? ' (included)' : ''}`, zats(t.tax));
  }
  label('Total', zats(t.total), true, 12);
  s.text(zec(t.total), right, 9, { right: true, color: GREY });
  s.y -= 18;
}

/** The invoice: logo, shop, customer, number, dates, items, totals, status, footer; open ones carry the payment QR and link. */
export async function invoicePdf(d: InvoiceDoc, opts: { logo?: string; state: State; link?: string; email?: string }): Promise<Uint8Array> {
  const { pdf, f, b } = await start(`Invoice ${d.number}`);
  const page = pdf.addPage([595.28, 841.89]);
  const s = new Sheet(page, f, b, 48);
  const logo = await logoImage(pdf, opts.logo);
  const top = s.y;
  shopHead(s, d.shop, logo);
  const right = s.margin + s.width;
  s.text('INVOICE', right, 20, { bold: true, right: true, y: top });
  s.text(d.number, right, 12, { bold: true, right: true, y: top - 22 });
  s.text(`Issued ${date(d.issuedAt)}`, right, 9, { right: true, color: GREY, y: top - 38 });
  if (d.expiresAt) s.text(`${d.kind === 'sent' ? 'Due' : 'Expires'} ${date(d.expiresAt)}`, right, 9, { right: true, color: GREY, y: top - 50 });
  s.text(STATE_LABEL[opts.state].toUpperCase(), right, 10, { bold: true, right: true, color: opts.state === 'paid' || opts.state === 'overpaid' ? rgb(0.05, 0.5, 0.42) : GREY, y: top - 66 });
  s.y = Math.min(s.y, top - 80) - 10;
  if (d.customer || opts.email) {
    s.text('Bill to', s.margin, 8.5, { bold: true, color: GREY });
    s.y -= 13;
    if (d.customer) {
      s.text(d.customer, s.margin, 10.5, { bold: true });
      s.y -= 13;
    }
    if (opts.email) {
      s.text(opts.email, s.margin, 9.5, { color: GREY });
      s.y -= 13;
    }
    s.y -= 6;
  }
  itemsTable(s, d);
  if (d.note) {
    s.text('Note', s.margin, 8.5, { bold: true, color: GREY });
    s.y -= 13;
    s.para(d.note, s.margin, s.width, 9.5);
    s.y -= 6;
  }
  if (opts.link && (opts.state === 'open' || opts.state === 'partial')) {
    s.y -= 4;
    const size = 128;
    const qr = await qrImage(pdf, d.creq);
    page.drawImage(qr, { x: s.margin, y: s.y - size, width: size, height: size });
    const tx = s.margin + size + 16;
    s.text('Pay with a zec-ecash wallet', tx, 11, { bold: true, y: s.y - 14 });
    const keep = s.y;
    s.y -= 30;
    s.para('Scan the code with the wallet, or open this link:', tx, s.width - size - 16, 9, GREY);
    s.para(opts.link, tx, s.width - size - 16, 7, GREY);
    s.y = Math.min(s.y, keep - size) - 14;
  }
  if (d.shop.footer) {
    s.y = Math.min(s.y, 70);
    s.rule();
    s.y -= 16;
    s.para(d.shop.footer, s.margin, s.width, 9.5, GREY);
  }
  page.drawRectangle({ x: 0, y: page.getHeight() - 6, width: page.getWidth(), height: 6, color: GOLD });
  return pdf.save();
}

/** The receipt: A4, or 80 mm wide for thermal printers (as tall as it needs). */
export async function receiptPdf(d: ReceiptDoc, opts: { logo?: string; link: string; width: 'a4' | '80mm' }): Promise<Uint8Array> {
  const { pdf, f, b } = await start(`Receipt ${d.number}`);
  const narrow = opts.width === '80mm';
  const w = narrow ? 80 * MM : 595.28;
  const h = narrow ? 330 + d.lines.length * 30 + (d.totals.tax ? 30 : 0) + 190 : 841.89;
  const page = pdf.addPage([w, h]);
  const s = new Sheet(page, f, b, narrow ? 4 * MM : 48);
  const logo = await logoImage(pdf, opts.logo);
  shopHead(s, d.shop, logo, narrow ? 13 : 18);
  s.y -= 8;
  s.text('RECEIPT', s.margin, narrow ? 12 : 18, { bold: true });
  s.y -= 16;
  s.text(`${d.number} · ${date(d.paidAt)}`, s.margin, narrow ? 8.5 : 10, { color: GREY });
  s.y -= 10;
  itemsTable(s, d, narrow);
  const right = s.margin + s.width;
  s.text('Paid', s.margin, 10, { bold: true });
  s.text(zats(d.paid), right, 10, { bold: true, right: true });
  s.y -= 14;
  s.text(zec(d.paid), right, 8.5, { right: true, color: GREY });
  s.y -= 18;
  const size = narrow ? 120 : 140;
  const qr = await qrImage(pdf, opts.link);
  page.drawImage(qr, { x: narrow ? (w - size) / 2 : s.margin, y: s.y - size, width: size, height: size });
  s.y -= size + 12;
  s.para(`Signed receipt. Request ${d.request.slice(0, 16)}...; key ${d.key.slice(0, 16)}...`, s.margin, s.width, 7, GREY);
  if (d.shop.footer) {
    s.y -= 4;
    s.para(d.shop.footer, s.margin, s.width, narrow ? 9 : 10);
  }
  return pdf.save();
}

export type ReportInput = {
  shop: string;
  from: number;
  to: number;
  figures: { total: number; count: number; average: number; openTotal: number; refunds: number; refundList: Array<{ number?: string; at: number; amount: number; what: string }>; days: Array<{ day: number; total: number }>; topItems: Array<{ name: string; revenue: number; qty: number }>; counter: number; sent: number };
  rows: Row[];
};

/** Sales for a period: totals, the daily chart, top items, the invoices and the refunds. */
export async function reportPdf(r: ReportInput): Promise<Uint8Array> {
  const { pdf, f, b } = await start(`Sales report ${day(r.from)} - ${day(r.to - 1)}`);
  let page = pdf.addPage([595.28, 841.89]);
  let s = new Sheet(page, f, b, 48);
  const more = () => {
    if (s.y > 80) return;
    page = pdf.addPage([595.28, 841.89]);
    s = new Sheet(page, f, b, 48);
  };
  s.text(r.shop, s.margin, 18, { bold: true });
  s.y -= 22;
  s.text(`Sales report · ${day(r.from)} to ${day(r.to - 1)}`, s.margin, 11, { color: GREY });
  s.y -= 26;
  const k = r.figures;
  const tiles: Array<[string, string]> = [
    ['Sales', zats(k.total)],
    ['Paid invoices', String(k.count)],
    ['Average sale', zats(k.average)],
    ['Open / unpaid', zats(k.openTotal)],
    ['Refunds', zats(k.refunds)],
    ['Counter / sent', `${zats(k.counter)} / ${zats(k.sent)}`],
  ];
  tiles.forEach(([label, v], i) => {
    const x = s.margin + (i % 3) * (s.width / 3);
    const y = s.y - Math.floor(i / 3) * 40;
    s.text(label, x, 8.5, { color: GREY, y });
    s.text(v, x, 12, { bold: true, y: y - 15 });
  });
  s.y -= 92;
  // the daily chart
  const ch = 120;
  const max = Math.max(1, ...k.days.map((d) => d.total));
  const bw = s.width / Math.max(1, k.days.length);
  s.page.drawLine({ start: { x: s.margin, y: s.y - ch }, end: { x: s.margin + s.width, y: s.y - ch }, thickness: 0.7, color: LINE });
  k.days.forEach((d, i) => {
    const hgt = (d.total / max) * (ch - 10);
    if (hgt > 0) s.page.drawRectangle({ x: s.margin + i * bw + bw * 0.15, y: s.y - ch, width: bw * 0.7, height: hgt, color: GOLD });
    if (k.days.length <= 16 || i % Math.ceil(k.days.length / 10) === 0) s.text(day(d.day), s.margin + i * bw + bw / 2 - 12, 6.5, { color: GREY, y: s.y - ch - 10 });
  });
  s.text(`max ${zats(max)} / day`, s.margin + s.width, 7.5, { color: GREY, right: true, y: s.y + 4 });
  s.y -= ch + 30;
  s.text('Top items', s.margin, 11, { bold: true });
  s.y -= 15;
  for (const it of k.topItems.slice(0, 8)) {
    s.text(it.name, s.margin, 9.5);
    s.text(`${it.qty} sold`, s.margin + s.width - 110, 9.5, { right: true, color: GREY });
    s.text(zats(it.revenue), s.margin + s.width, 9.5, { right: true });
    s.y -= 13;
  }
  if (!k.topItems.length) {
    s.text('No items sold in this period.', s.margin, 9.5, { color: GREY });
    s.y -= 13;
  }
  s.y -= 12;
  more();
  s.text('Invoices', s.margin, 11, { bold: true });
  s.y -= 15;
  const cols = [0, 70, 150, 300, 400];
  ['Number', 'State', 'Customer', 'Paid', 'Total'].forEach((h, i) => s.text(h, i >= 3 ? s.margin + (i === 3 ? 420 : s.width) : s.margin + cols[i], 8.5, { bold: true, color: GREY, right: i >= 3 }));
  s.y -= 6;
  s.rule();
  s.y -= 12;
  for (const row of r.rows) {
    more();
    s.text(row.inv.number ?? '(draft)', s.margin, 9);
    s.text(STATE_LABEL[row.state], s.margin + cols[1], 9, { color: GREY });
    s.text((row.inv.customer?.name ?? (row.inv.kind === 'counter' ? 'counter sale' : '')).slice(0, 28), s.margin + cols[2], 9);
    s.text(group.format(row.paid), s.margin + 420, 9, { right: true });
    s.text(group.format(row.total), s.margin + s.width, 9, { right: true });
    s.y -= 13;
  }
  if (k.refundList.length) {
    s.y -= 12;
    more();
    s.text('Refunds', s.margin, 11, { bold: true });
    s.y -= 15;
    for (const f2 of k.refundList) {
      more();
      s.text(`${f2.number ?? ''} · ${date(f2.at)} · ${f2.what}`, s.margin, 9);
      s.text(zats(f2.amount), s.margin + s.width, 9, { right: true });
      s.y -= 13;
    }
  }
  return pdf.save();
}
