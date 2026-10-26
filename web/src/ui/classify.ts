// What a scanned or pasted code is, so one Scan button can do the right thing with it. No DOM.

export type Code =
  | { kind: 'token'; text: string }
  | { kind: 'request'; text: string }
  | { kind: 'address'; text: string }
  | { kind: 'pubkey'; text: string }
  | { kind: 'unknown'; text: string };

const ADDRESS = /^(u1|utest1|uregtest1|zs1|ztestsapling1|zregtestsapling1)[02-9ac-hj-np-z]{20,}$/;
const TRANSPARENT = /^t[13m][1-9A-HJ-NP-Za-km-z]{33}$/;

export function classify(raw: string): Code {
  let text = raw.trim();
  // cashu:cashuB… (NUT-00 URI) and web+cashu: links carry the token after the scheme.
  text = text.replace(/^(web\+)?cashu:(\/\/)?/i, '');
  if (/^cashu[AB][A-Za-z0-9_=+/-]+$/.test(text)) return { kind: 'token', text };
  if (/^creq[AB]/i.test(text)) return { kind: 'request', text };
  if (/^zcash:/i.test(text)) return { kind: 'address', text };
  if (ADDRESS.test(text) || TRANSPARENT.test(text)) return { kind: 'address', text };
  if (/^0[23][0-9a-fA-F]{64}$/.test(text)) return { kind: 'pubkey', text: text.toLowerCase() };
  return { kind: 'unknown', text };
}

export const UNKNOWN_CODE = 'This code isn’t something this wallet understands.';
