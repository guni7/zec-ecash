// Invoice and receipt links that work without the shop online: the document as JSON, signed
// (BIP-340 over SHA-256) with the key of the invoice's payment request, deflated and base64url'd
// into #/invoice/<data> or #/receipt/<data>.
//
// The signature binds the document to the key its payment request is locked to (the one key that
// can spend the payments), so the items, total or request can't be changed in transit. It does
// not prove who the shop is: anyone can sign their own invoice. The logo is never in a link.
// Customer email addresses stay on the shop's device; only the customer's name travels.
import { decodePaymentRequest } from '@cashu/cashu-ts';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Line } from './model';

export type ShopInfo = { name: string; address?: string; taxId?: string; contact?: string; footer?: string };

export type InvoiceDoc = {
  v: 1;
  shop: ShopInfo;
  number: string;
  kind: 'counter' | 'sent';
  customer?: string;
  lines: Line[];
  taxRate?: number;
  taxIncluded: boolean;
  totals: { subtotal: number; tax: number; total: number };
  issuedAt: number;
  expiresAt?: number;
  note?: string;
  /** The payment request (creqA…), locked to the key that signed this. */
  creq: string;
};

export type ReceiptDoc = {
  v: 1;
  shop: ShopInfo;
  number: string;
  lines: Line[];
  taxRate?: number;
  taxIncluded: boolean;
  totals: { subtotal: number; tax: number; total: number };
  paid: number;
  paidAt: number;
  /** The payment request's id and the key it was locked to (which signed this). */
  request: string;
  key: string;
};

type Kind = 'invoice' | 'receipt';
const TAG = (k: Kind) => `zec-ecash-${k}-v1\n`;
const digest = (k: Kind, doc: unknown) => sha256(utf8ToBytes(TAG(k) + JSON.stringify(doc)));

const b64url = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
};

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The public key a payment request is locked to (hex, compressed). */
export function requestKey(creq: string): string {
  const k = decodePaymentRequest(creq).nut10;
  if (k?.kind !== 'P2PK') throw new Error('This payment request isn’t locked to a key.');
  return k.data.toLowerCase();
}

/** Signs and packs a document for a link. `priv`: the request key (hex). */
export async function pack(kind: Kind, doc: InvoiceDoc | ReceiptDoc, priv: string): Promise<string> {
  const s = bytesToHex(schnorr.sign(digest(kind, doc), hexToBytes(priv)));
  return b64url(await pipe(utf8ToBytes(JSON.stringify({ d: doc, s })), new CompressionStream('deflate')));
}

export type Unpacked<T> = { doc: T; valid: boolean; key: string };

/** Unpacks a link's data and checks its signature (`valid`). Throws if it isn't one of ours at all. */
export async function unpack<T extends InvoiceDoc | ReceiptDoc>(kind: Kind, data: string): Promise<Unpacked<T>> {
  let parsed: { d: T; s: string };
  try {
    parsed = JSON.parse(new TextDecoder().decode(await pipe(unb64url(data), new DecompressionStream('deflate'))));
  } catch {
    throw new Error(`This ${kind} link is damaged or incomplete.`);
  }
  if (!parsed?.d || typeof parsed.s !== 'string' || parsed.d.v !== 1) throw new Error(`This ${kind} link is damaged or incomplete.`);
  let key = '';
  let valid = false;
  try {
    key = kind === 'invoice' ? requestKey((parsed.d as InvoiceDoc).creq) : (parsed.d as ReceiptDoc).key;
    valid = schnorr.verify(hexToBytes(parsed.s), digest(kind, parsed.d), hexToBytes(key).slice(1));
  } catch {
    valid = false;
  }
  return { doc: parsed.d, valid, key };
}
