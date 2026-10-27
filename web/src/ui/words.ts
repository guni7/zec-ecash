// Plain words for people: amounts as zats first with ZEC underneath (or the other way round,
// a Settings toggle), amount parsing in either unit, and wallet errors rewritten without
// "mint", "token", "proof" and friends. No DOM, so the unit tests can run it.
import { zatToZec } from '../wallet/onchain';

const ZAT_PER_ZEC = 100_000_000;
const group = new Intl.NumberFormat('en-US');

let zatsFirst = true;
export const setZatsFirst = (v: boolean) => (zatsFirst = v);
export const isZatsFirst = () => zatsFirst;

export const zecText = (zat: number) => `${zatToZec(Math.abs(zat))} ZEC`;
export const zatsText = (zat: number) => `${group.format(Math.abs(zat))} ${Math.abs(zat) === 1 ? 'zat' : 'zats'}`;

/** The two lines of an amount: { main: '0.0006 ZEC', sub: '60,000 zats' } (swapped if zats first). */
export function money(zat: number): { main: string; sub: string } {
  return zatsFirst ? { main: zatsText(zat), sub: zecText(zat) } : { main: zecText(zat), sub: zatsText(zat) };
}

/** One amount inside a sentence, in the primary unit. */
export const moneyText = (zat: number) => money(zat).main;

/** Unit the amount fields take. */
export const inputUnit = (): 'ZEC' | 'zats' => (zatsFirst ? 'zats' : 'ZEC');

/** What a person typed, in `unit`, to zats. Throws a plain-language Error; '' is "no amount" (null). */
export function parseAmount(text: string, unit: 'ZEC' | 'zats'): number | null {
  let t = text.trim().replace(/\s+/g, '');
  if (!t) return null;
  if (unit === 'zats') {
    t = t.replace(/,/g, '');
    if (!/^\d+$/.test(t)) throw new Error('Enter a whole number of zats.');
    const n = Number(t);
    if (n <= 0) throw new Error('Enter an amount above zero.');
    if (!Number.isSafeInteger(n)) throw new Error('That amount is too large.');
    return n;
  }
  // Phone keyboards in many countries only offer a comma: "0,0006" is 0.0006 ZEC.
  if (!t.includes('.') && (t.match(/,/g) ?? []).length === 1) t = t.replace(',', '.');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (!m[1] && !m[2])) throw new Error('Enter an amount like 0.001.');
  if ((m[2] ?? '').length > 8) throw new Error('ZEC has at most 8 decimal places.');
  const zat = Number(m[1] || '0') * ZAT_PER_ZEC + Number((m[2] ?? '').padEnd(8, '0'));
  if (zat <= 0) throw new Error('Enter an amount above zero.');
  if (!Number.isSafeInteger(zat)) throw new Error('That amount is too large.');
  return zat;
}

/** zats to what an amount field shows in `unit` (no grouping, so it parses back). */
export const amountForInput = (zat: number, unit: 'ZEC' | 'zats') => (unit === 'zats' ? String(zat) : zatToZec(zat));

const n = (s: string) => Number(s.replace(/,/g, ''));
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

type Rule = [RegExp, string | null | ((m: RegExpExecArray) => string | null)];

// Messages the wallet modules throw or say, newest wording first. `null` drops a message the
// page already shows (the deposit address, for one).
const RULES: Rule[] = [
  // tokens.ts / core.ts
  [/^Already spent/i, 'This code was already used. Ask them for a new one.'],
  [/Mint unreachable/, 'Can’t reach the service. Check your connection and try again; your money is safe on this device.'],
  [/^Not enough ecash/, 'You don’t have enough money for that.'],
  [/^Enter a whole number of zat/, 'Enter an amount.'],
  [/^Paste or scan a token first/, 'Scan or paste a code first.'],
  [/^That is not a Cashu token/, 'This isn’t a money code.'],
  [/^Wrong mint: this token is from (\S+?);/, (m) => `This money is from another service (${host(m[1])}), so this wallet can’t take it.`],
  [/^Wrong unit/, 'This code is in a currency this wallet doesn’t use.'],
  [/^Offline, not accepted: .*not locked to your key/, 'You’re offline, and this code isn’t locked to you, so it can’t be checked. Receive it when you’re back online, or show them your code first.'],
  [/^Offline, not accepted: .*no DLEQ proofs/, 'You’re offline, and this code can’t be checked without a connection. Receive it when you’re back online, or show them your code first.'],
  [/^Offline, not accepted: .*(forged|damaged)/, 'This code is damaged or fake. Don’t accept it.'],
  [/^Offline, not accepted/, 'You’re offline and this code can’t be checked yet. Try again when you’re back online.'],
  [/already waiting to be redeemed/, 'You already received this code. It’s confirmed when you’re back online.'],
  [/^That isn't a public key/, 'That isn’t someone’s receive code.'],
  [/recipient already redeemed it/, 'They already took it, so there’s nothing to take back.'],
  [/locked to the recipient; only they can redeem/, 'Only they can take this money, so it can’t be taken back.'],
  // posreq.ts / pos.ts
  [/^That is not a payment request/, 'That isn’t a payment code.'],
  [/doesn't accept this wallet's mint/, 'This payment code is for another service, so this wallet can’t pay it.'],
  [/^The request is in /, 'This payment code is in a currency this wallet doesn’t use.'],
  [/lock (has extra conditions|key is not)|asks for a .* lock|no HTTP transport/, 'This wallet can’t pay this kind of payment code.'],
  [/^The request has no amount/, 'This payment code has no amount.'],
  [/^Point of sale is offline/, 'Payment codes are unavailable right now. Try again in a minute.'],
  [/^Point of sale: (.*)/, (m) => `The payment service said: ${m[1]}`],
  [/^The shop’s point of sale is unreachable/, 'Can’t reach their payment service. Your payment is saved; try again in a minute.'],
  // onchain.ts
  [/^The mint's (minimum|maximum) (.*) is (\d+) /, (m) => `The ${m[1]} is ${moneyText(n(m[3]))}.`],
  [/^This quote has expired/, 'The fee quote expired. Tap Review again.'],
  [/^Tick the box/, 'Tick the box to confirm.'],
  [/payment URI asks for several payments/, 'This payment link asks for several payments; this wallet sends one at a time.'],
  [/^The payment URI's amount/, 'The payment link’s amount isn’t a ZEC amount.'],
  [/^The payment URI has no address/, 'The payment link has no address.'],
  [/^Enter the (.*) as a whole number of zat/, 'Enter an amount.'],
  [/^Deposit quote created/, null],
  [/^Deposit quote for \d+ \w+ expired unpaid/, 'An add-money address expired unpaid. Don’t pay it now.'],
  [/^Deposit confirmed: minted (\d+)/, (m) => `Added ${moneyText(n(m[1]))} to your wallet.`],
  [/^Withdrawal of (\d+) \w+ is pending/, (m) => `Cashing out ${moneyText(n(m[1]))}: the keyholders approve it, then it’s sent.`],
  [/^Withdrawal sent, but the connection dropped/, 'Cash-out sent, but the connection dropped. It’s saved here and finishes by itself.'],
  [/^Withdrawal not sent: (.*?) The \d+ \w+ are back/, (m) => `Cash-out not sent: ${plain(m[1])} The money is back in your wallet.`],
  [/^Withdrawal paid: (\d+) /, (m) => `Cashed out ${moneyText(n(m[1]))}.`],
  [/^Deposit \S+: (.*) \(will retry\)/, (m) => `Adding money: ${plain(m[1])} Retrying.`],
  [/^Withdrawal \S+: (.*) \(will retry\)/, (m) => `Cash-out: ${plain(m[1])} Retrying.`],
  [/^Redeemed (\d+) \w+ accepted offline/, (m) => `Confirmed ${moneyText(n(m[1]))} you received offline.`],
  [/^An offline-accepted token could not be redeemed: (.*)/, (m) => `Money you received offline couldn’t be confirmed: ${plain(m[1])}`],
  [/^Collected ([\d,]+) /, (m) => `Received ${moneyText(n(m[1]))}.`],
  [/^Partial payment received: ([\d,]+) of ([\d,]+)/, (m) => `Partial payment: ${moneyText(n(m[1]))} of ${moneyText(n(m[2]))}. Your code is still unpaid; you can refund it.`],
  [/^Extra payment received: ([\d,]+)/, (m) => `Extra payment: ${moneyText(n(m[1]))} (your code was already paid). You can refund it.`],
  // backup.ts
  [/^This wallet holds ecash/, 'This wallet isn’t empty. Restore only into an empty wallet: download its backup, then reset it.'],
];

/** A wallet message in plain words; null if the page already says it. */
export function plainOrNull(text: string): string | null {
  for (const [re, out] of RULES) {
    const m = re.exec(text);
    if (m) return typeof out === 'function' ? out(m) : out;
  }
  // Anything else (a server's own words): at least drop the jargon.
  return text
    .replace(/\bThe mint refused: /, 'The service said no: ')
    .replace(/\becash\b/gi, 'money')
    .replace(/\btokens\b/g, 'codes')
    .replace(/\btoken\b/g, 'code')
    .replace(/\bthe mint\b/gi, 'the service')
    .replace(/\b(\d[\d,]*) zat\b/g, (_, d: string) => `${d} ${d === '1' ? 'zat' : 'zats'}`);
}

export const plain = (text: string) => plainOrNull(text) ?? text;
