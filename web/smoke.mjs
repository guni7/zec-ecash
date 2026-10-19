// Desktop smoke test of the page's cashu-ts calls (same library, mint URL and unit), no phone:
//   cd web && NODE_EXTRA_CA_CERTS=certs/rootCA.pem SMOKE_STORE=/tmp/proofs.json \
//     ZEC_MINT_URL=https://<host>:5173/mint node smoke.mjs receive <token> | send <zat> | balance
import { Amount, MintOperationError, Wallet, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
const [mode, arg] = process.argv.slice(2);
const MINT_URL = process.env.ZEC_MINT_URL;
if (!MINT_URL) throw new Error('set ZEC_MINT_URL (see .env)');
const w = new Wallet(MINT_URL, { unit: 'zat', denominationTarget: 0 }); // same as the page
await w.loadMint();
const fs = await import('node:fs');
const STORE = process.env.SMOKE_STORE ?? 'smoke-proofs.json';
const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : []).map((p) => ({ ...p, amount: Amount.from(p.amount) }));
const save = (ps) => fs.writeFileSync(STORE, JSON.stringify(ps));
const bal = (ps) => Amount.sum(ps.map((p) => p.amount)).toString();
if (mode === 'receive') {
  const meta = getTokenMetadata(arg);
  console.log(`token: ${meta.amount} ${meta.unit} from ${meta.mint}`);
  try {
    const got = await w.receive(arg);
    const ps = [...load(), ...got]; save(ps);
    console.log(`received ${bal(got)} zat; balance ${bal(ps)} zat`);
  } catch (e) {
    console.log(e instanceof MintOperationError ? `MintOperationError code ${e.code}: ${e.message}` : `error: ${e.message}`);
  }
} else if (mode === 'send') {
  const { keep, send } = await w.send(Number(arg), load());
  save(keep);
  const tok = getEncodedToken({ mint: MINT_URL, unit: 'zat', proofs: send });
  process.stdout.write(tok + '\n');
  console.error(`sent ${arg} zat in ${send.length} proofs, ${tok.length} chars; balance ${bal(keep)} zat`);
} else console.log(`balance ${bal(load())} zat`);
