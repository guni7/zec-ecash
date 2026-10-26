// Devnet test of the locked point of sale at the API level (no browser): this script plays the
// payee's phone (its own keys) and the payers (cashu-ts wallets funded from the CLI wallet).
//
//   scripts/devnet-up.sh; cd web
//   NODE_EXTRA_CA_CERTS=certs/rootCA.pem node tests/e2e/pos-api.mjs
//
// Covers: an exact payment -> PAID -> the phone collects -> balance up and the server's copy
// deleted; refusals (unlocked, wrong key, refund/locktime, no DLEQ, already spent, reused proof,
// underpayment, wrong mint); two concurrent payers -> exactly one PAID; collecting with a wrong,
// expired or wrong-action signature refused; ack refused before the proofs are spent; lookup by key.
import { execFileSync } from 'node:child_process';
import { Amount, Wallet, getEncodedToken } from '@cashu/cashu-ts';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const REPO = new URL('../../..', import.meta.url).pathname;
const HOST = process.env.WEB_HOST ?? 'gunits-macbook-pro-2.local';
const ORIGIN = `https://${HOST}:5173`;
const MINT = `${ORIGIN}/mint`;
const POS = `${ORIGIN}/pos`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (cond, what) => {
  if (!cond) {
    failures++;
    console.log(`FAILED: ${what}`);
  } else log(`ok: ${what}`);
};
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ZEC_MINT_CA: 'web/certs/rootCA.pem' } });
const sql = (q) => sh('sqlite3', ['devnet/pos/pos.sqlite', q]).trim();

const newKey = () => {
  const sk = randomBytes(32);
  return { priv: bytesToHex(sk), pub: bytesToHex(secp256k1.getPublicKey(sk, true)) };
};
const sign = (priv, action, subject, t = Math.floor(Date.now() / 1000)) => ({
  'x-pos-time': String(t),
  'x-pos-sig': bytesToHex(schnorr.sign(sha256(utf8ToBytes(`zec-ecash-pos-v1\n${action}\n${subject}\n${t}`)), hexToBytes(priv))),
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
const create = async (amount, pub) => json(await fetch(`${POS}/create?amount=${amount}&unit=zat&pubkey=${pub}`));
const proofsJson = (ps) => ps.map((p) => ({ id: p.id, amount: Number(String(p.amount)), secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) }));
const deliver = async (id, proofs, mint = MINT) =>
  json(await fetch(`${POS}/payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, mint, unit: 'zat', proofs: proofsJson(proofs) }) }));
const collect = async (id, priv, headers) => json(await fetch(`${POS}/requests/${id}/payment`, { headers: headers ?? sign(priv, 'collect', id) }));
const ack = async (id, priv, headers) => json(await fetch(`${POS}/requests/${id}/ack`, { method: 'POST', headers: headers ?? sign(priv, 'ack', id) }));
const ackExtra = async (id, n, priv, headers) => json(await fetch(`${POS}/requests/${id}/ack?extra=${n}`, { method: 'POST', headers: headers ?? sign(priv, 'ack', `${id}/extra/${n}`) }));
/** Redeems a stored token with the request key; returns the amount. */
const redeem = async (token, priv) => {
  const out = await phone.completeSwap(await phone.prepareSwapToReceive(token, { requireDleq: true }), priv);
  return [...out.keep, ...out.send].reduce((a, p) => a + Number(String(p.amount)), 0);
};
let phone;

// ---- a funded payer wallet (from the CLI's ecash wallet) ----
const payer = new Wallet(MINT, { unit: 'zat', denominationTarget: 0 });
await payer.loadMint();
let proofs = [];
const fund = (zat) => {
  const out = sh('./target/release/zec-ecash-cli', ['send', String(zat)]);
  return out.match(/cashuB[A-Za-z0-9_-]+/)[0];
};
proofs = await payer.receive(fund(Number(process.env.FUND ?? 2600)));
const bal = () => proofs.reduce((a, p) => a + Number(String(p.amount)), 0);
log(`payer funded: ${bal()} zat`);
/** Proofs for `amount`, P2PK-locked as given (or unlocked), with DLEQ proofs. */
async function pay(amount, lock) {
  const { keep, send } = lock ? await payer.send(amount, proofs, undefined, { send: { type: 'p2pk', options: lock } }) : await payer.send(amount, proofs);
  proofs = keep;
  return send;
}
const legacyBefore = sh('./target/debug/pos', ['balance']).match(/holds (\d+)/)[1];

// ---- 1. exact payment -> PAID -> collect -> ack -> server copy deleted ----
const K1 = newKey();
const r1 = await create(200, K1.pub);
check(r1.status === 200 && r1.body.request?.startsWith('creqA'), `request created, locked to the phone's key (${r1.body.id?.slice(0, 8)}…)`);
check(sql(`SELECT pubkey FROM pos_quote WHERE id='${r1.body.id}'`) === K1.pub, 'server stored the request key');
const dup = await create(100, K1.pub);
check(dup.status === 409, `same key for a second request refused (${dup.status}: ${dup.body.error})`);
const p1 = await pay(200, { pubkey: K1.pub });
const d1 = await deliver(r1.body.id, p1);
check(d1.status === 200 && d1.body.state === 'PAID', `exact locked payment accepted: ${JSON.stringify(d1.body)}`);
check(sql(`SELECT token IS NOT NULL FROM pos_quote WHERE id='${r1.body.id}'`) === '1', 'server stored the token');
const states1 = await payer.checkProofsStates(p1);
check(states1.every((s) => s.state === 'UNSPENT'), 'the server claimed nothing: the proofs are still unspent');
const early = await ack(r1.body.id, K1.priv);
check(early.status === 409, `ack before collecting refused (${early.status}: ${early.body.error})`);
const c1 = await collect(r1.body.id, K1.priv);
check(c1.status === 200 && c1.body.token?.startsWith('cashuB'), 'phone fetched the stored token with a signed request');
phone = new Wallet(MINT, { unit: 'zat', denominationTarget: 0 });
await phone.loadMint();
const preview = await phone.prepareSwapToReceive(c1.body.token, { requireDleq: true });
const got = await phone.completeSwap(preview, K1.priv);
const gotSum = [...got.keep, ...got.send].reduce((a, p) => a + Number(String(p.amount)), 0);
check(gotSum === 200, `phone redeemed it (swap signed with the request key): +${gotSum} zat`);
const a1 = await ack(r1.body.id, K1.priv);
check(a1.status === 200 && a1.body.ok, 'phone acked');
check(sql(`SELECT token IS NULL AND proofs IS NULL AND collected_at IS NOT NULL FROM pos_quote WHERE id='${r1.body.id}'`) === '1', "server's copy deleted");
const c1b = await collect(r1.body.id, K1.priv);
check(c1b.body.token === null && c1b.body.collected === true, 'collect after ack: nothing left, collected');

// ---- 2. refusals ----
const K2 = newKey();
const r2 = await create(150, K2.pub);
const id2 = r2.body.id;
const refused = async (what, prfs, re, mint) => {
  const d = await deliver(id2, prfs, mint);
  check(d.status >= 400 && re.test(d.body.error ?? ''), `refused ${what}: ${d.status} ${d.body.error}`);
  const st = await payer.checkProofsStates(prfs);
  return st.every((s) => s.state === 'UNSPENT');
};
const unlocked = await pay(150);
check(await refused('an unlocked token', unlocked, /not locked/), '  … and the payer still holds the unlocked proofs (refund path kept)');
proofs = [...proofs, ...unlocked];
const wrongKey = newKey();
const wrong = await pay(150, { pubkey: wrongKey.pub });
await refused('a token locked to another key', wrong, /different key/);
const withRefund = await pay(150, { pubkey: K2.pub, locktime: Math.floor(Date.now() / 1000) + 3600, refundKeys: [newKey().pub] });
await refused('a lock with locktime and refund keys', withRefund, /locktime or refund/);
const noDleq = (await pay(150, { pubkey: K2.pub })).map((p) => ({ ...p, dleq: undefined }));
await refused('proofs without DLEQ', noDleq, /DLEQ/);
// An underpayment only the payee can spend is never refused: it's a partial payment.
const under = await deliver(id2, await pay(100, { pubkey: K2.pub }));
check(under.status === 200 && under.body.partial && under.body.received === 100 && under.body.requested === 150 && under.body.state === 'UNPAID', `an on-time underpayment is kept as a partial payment, request still unpaid: "${under.body.note}"`);
const goodForK2 = await pay(150, { pubkey: K2.pub });
await refused('a payment naming another mint', goodForK2, /wrong mint/, 'https://other.example/mint');
// already spent: proofs correctly locked to K2, but redeemed at the mint before delivery
const spentFirst = await pay(150, { pubkey: K2.pub });
await phone.receive(getEncodedToken({ mint: MINT, unit: 'zat', proofs: spentFirst }), { privkey: K2.priv });
await refused('proofs already spent at the mint', spentFirst, /already spent/);
// reused proof: p1 was accepted for request 1
await refused('proofs already accepted for another request', p1, /already accepted for another request/);
check(sql(`SELECT state FROM pos_quote WHERE id='${id2}'`) === 'UNPAID', 'after the refusals and the partial payment, request 2 is still UNPAID');
const c2p = await collect(id2, K2.priv);
const part = c2p.body.extras?.find((e) => e.kind === 'partial');
check(part?.received === 100 && part.token && (await redeem(part.token, K2.priv)) === 100, 'phone collects the partial payment (100 zat) while the request is unpaid');
check((await ackExtra(id2, part.n, K2.priv)).body.ok, 'partial payment acked; server copy deleted');
const d2 = await deliver(id2, goodForK2);
check(d2.status === 200, 'the correct payment for request 2 is then accepted');

// ---- 3. two concurrent payers -> one PAID plus one extra payment, both collected ----
const K3 = newKey();
const r3 = await create(120, K3.pub);
const [pa, pb] = [await pay(120, { pubkey: K3.pub }), await pay(120, { pubkey: K3.pub })];
const both = await Promise.all([deliver(r3.body.id, pa), deliver(r3.body.id, pb)]);
check(
  both.every((d) => d.status === 200) && both.filter((d) => !d.body.extra).length === 1 && both.filter((d) => d.body.extra).length === 1,
  `concurrent payers: one PAID, the other kept as an extra payment (${both.map((d) => `${d.status}${d.body.extra ? ' extra' : ''}`).join(', ')})`,
);
check(/already paid.*refund/.test(both.find((d) => d.body.extra).body.note), `the late payer is told: "${both.find((d) => d.body.extra).body.note}"`);
const c3 = await collect(r3.body.id, K3.priv);
check(c3.body.token && c3.body.extras?.length === 1 && c3.body.extras[0].token, 'phone gets the main payment and the extra payment');
const main3 = await redeem(c3.body.token, K3.priv);
const extra3 = await redeem(c3.body.extras[0].token, K3.priv);
check(main3 === 120 && extra3 === 120, `phone collected both: ${main3} + ${extra3} zat`);
const badExtraAck = await ackExtra(r3.body.id, 1, K3.priv, sign(K3.priv, 'ack', r3.body.id));
check(badExtraAck.status === 401, "an extra payment's ack needs its own signed subject");
check((await ack(r3.body.id, K3.priv)).body.ok && (await ackExtra(r3.body.id, 1, K3.priv)).body.ok, 'both acked');
check(sql(`SELECT COUNT(*) FROM pos_extra WHERE quote_id='${r3.body.id}' AND token IS NULL AND collected_at IS NOT NULL`) === '1', "server's copy of the extra payment deleted");

// ---- late payments to a request that is already PAID (and collected) ----
const late = await deliver(r1.body.id, await pay(250, { pubkey: K1.pub }));
check(late.status === 200 && late.body.extra, `a correctly locked payment to a PAID request is kept as an extra payment (${late.body.received} zat)`);
const lateWrong = await deliver(r1.body.id, await pay(250, { pubkey: newKey().pub }));
check(lateWrong.status === 400 && /different key/.test(lateWrong.body.error), `late but wrongly locked: still refused (${lateWrong.body.error})`);
const lateUnder = await deliver(r1.body.id, await pay(100, { pubkey: K1.pub }));
check(lateUnder.status === 200 && lateUnder.body.partial && lateUnder.body.state === 'PAID', `a late underpayment is kept as a partial payment too (${lateUnder.body.received} of 200)`);
const lateReuse = await deliver(r1.body.id, p1);
check(lateReuse.status === 409 && /already accepted/.test(lateReuse.body.error), 'late payment reusing accepted proofs: still refused');
const c1x = await collect(r1.body.id, K1.priv);
const [x1, x2] = c1x.body.extras ?? [];
check(x1?.kind === 'extra' && x1.received === 250 && x2?.kind === 'partial' && x2.received === 100, 'phone sees the late extra (250) and the late partial (100)');
check((await redeem(x1.token, K1.priv)) === 250 && (await redeem(x2.token, K1.priv)) === 100, 'phone collects both');
check((await ackExtra(r1.body.id, x1.n, K1.priv)).body.ok && (await ackExtra(r1.body.id, x2.n, K1.priv)).body.ok, 'both acked');

// ---- 4. signatures ----
const bad = await collect(r3.body.id, newKey().priv);
check(bad.status === 401 && bad.body.token === undefined, `collect signed by another key refused (${bad.status}: ${bad.body.error})`);
const old = await collect(r3.body.id, K3.priv, sign(K3.priv, 'collect', r3.body.id, Math.floor(Date.now() / 1000) - 600));
check(old.status === 401 && /expired/.test(old.body.error), `expired signature refused (${old.body.error})`);
const wrongAction = await ack(r3.body.id, K3.priv, sign(K3.priv, 'collect', r3.body.id));
check(wrongAction.status === 401, `a collect signature can't ack (${wrongAction.status})`);
const none = await json(await fetch(`${POS}/requests/${r3.body.id}/payment`));
check(none.status === 401, `unsigned collect refused (${none.body.error})`);

// ---- 5. lookup by key (restore) ----
const look = await json(await fetch(`${POS}/keys/${K3.pub}/requests`, { headers: sign(K3.priv, 'lookup', K3.pub) }));
const lr = look.body.requests?.[0];
check(
  look.status === 200 && lr?.id === r3.body.id && lr.collected && !lr.has_payment && lr.token === null && lr.extras?.length === 1 && lr.extras[0].token === null,
  'signed lookup by key finds the request (collected, with its extra payment; no tokens in the listing)',
);
const lookBad = await json(await fetch(`${POS}/keys/${K3.pub}/requests`, { headers: sign(newKey().priv, 'lookup', K3.pub) }));
check(lookBad.status === 401, 'lookup signed by another key refused');

// ---- nothing new landed in the legacy POS wallet ----
const legacyAfter = sh('./target/debug/pos', ['balance']).match(/holds (\d+)/)[1];
check(legacyBefore === legacyAfter, `legacy POS wallet unchanged (${legacyAfter} zat)`);

// return the payer's leftovers to the CLI wallet
if (bal()) sh('./target/release/zec-ecash-cli', ['receive', getEncodedToken({ mint: MINT, unit: 'zat', proofs })]);
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exitCode = failures ? 1 : 0;
