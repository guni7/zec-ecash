// Test helper: change ONE hex character of the first proof's signature (C) and re-encode.
// Picks the first position whose change still gives a valid curve point, so the token still
// parses and only the signature check can catch it.
import { getEncodedToken, Wallet } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
const [token] = process.argv.slice(2);
const w = new Wallet(process.env.ZEC_MINT_URL, { unit: 'zat' });
await w.loadMint();
const t = w.decodeToken(token);
const C = t.proofs[0].C;
for (let i = 2; i < C.length; i++) {
  const c = C[i] === 'a' ? 'b' : 'a';
  const C2 = C.slice(0, i) + c + C.slice(i + 1);
  try { secp256k1.Point.fromHex(C2); } catch { continue; }
  t.proofs[0].C = C2;
  console.error(`changed C[${i}] ${C[i]} -> ${c}`);
  break;
}
console.log(getEncodedToken(t));
