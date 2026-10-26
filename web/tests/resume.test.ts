// Resuming saved deposits and withdrawals after a reload (initOnchain(...).resume()), against a
// fake mint. Each test starts from what localStorage would hold after the page went away.
import './setup';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Amount, OutputData, type Proof, type Wallet } from '@cashu/cashu-ts';
import { initOnchain, type Deposit, type Withdrawal } from '../src/wallet/onchain';

const MINT = 'https://mint.test/mint';
const KEYSET = '009a1f293253e41e';
const DEP = `zec-ecash-demo:deposits:${MINT}`;
const WD = `zec-ecash-demo:withdrawals:${MINT}`;

type Call = { name: string; args: unknown[]; storage?: string | null };

/** Builds a proof the way the fake mint "signs" an output (secret from its OutputData). */
const proofFor = (o: OutputData): Proof => ({ id: KEYSET, amount: Amount.from(o.blindedMessage.amount), secret: Buffer.from(o.secret).toString('hex'), C: `02${'c'.repeat(64)}` });
const outputs = (...amounts: number[]) => amounts.map((a) => OutputData.createSingleRandomData(a, KEYSET));

function harness(mint: Partial<Record<string, (...a: never[]) => unknown>>) {
  const calls: Call[] = [];
  const record = (name: string, fn?: (...a: never[]) => unknown) => async (...args: never[]) => {
    calls.push({ name, args, storage: name === 'completeMint' ? localStorage.getItem(DEP) : name === 'completeMelt' ? localStorage.getItem(WD) : undefined });
    if (!fn) throw new Error(`fake mint: unexpected ${name}`);
    return fn(...args);
  };
  const wallet = {
    checkMintQuote: record('checkMintQuote', mint.checkMintQuote),
    prepareMint: record('prepareMint', mint.prepareMint),
    completeMint: record('completeMint', mint.completeMint),
    checkMeltQuote: record('checkMeltQuote', mint.checkMeltQuote),
    completeMelt: record('completeMelt', mint.completeMelt),
    checkProofsStates: record('checkProofsStates', mint.checkProofsStates),
    ensureOperableKeysets: async () => {},
    createMeltChangeProofs: (data: OutputData[], sigs: unknown[]) => data.slice(0, sigs.length).map(proofFor),
    keyChain: {
      getKeyset: () => {
        throw new Error('no keys in the fake');
      },
    },
    mint: { restore: record('restore', mint.restore) },
  } as unknown as Wallet;
  let proofs: Proof[] = [];
  const said: string[] = [];
  const onchain = initOnchain({
    mintUrl: MINT,
    unit: 'zat',
    mainnet: false,
    connect: async () => wallet,
    proofs: () => proofs,
    setProofs: (p) => (proofs = p),
    say: (t) => said.push(t),
    explain: (e) => (e instanceof Error ? e.message : String(e)),
    isNetworkError: (e) => e instanceof TypeError,
  });
  return { onchain, calls, said, balance: () => proofs.reduce((a, p) => a + Number(p.amount.toString()), 0), proofs: () => proofs };
}

const saved = <T>(key: string) => JSON.parse(localStorage.getItem(key) ?? '[]') as T[];

beforeEach(() => localStorage.clear());

test('deposit: paid while the page was closed -> minted on resume, outputs saved before the request', async () => {
  localStorage.setItem(DEP, JSON.stringify([{ quote: 'q1', amount: 3072, address: 'u', expiry: null, created: 1, state: 'unpaid' } satisfies Deposit]));
  const outs = outputs(2048, 1024);
  const t = harness({
    checkMintQuote: () => ({ quote: 'q1', amount_paid: 3072, amount_issued: 0 }),
    prepareMint: () => ({ method: 'zec', payload: { quote: 'q1', outputs: outs.map((o) => o.blindedMessage), signature: 'sig' }, outputData: outs, keysetId: KEYSET, quote: { quote: 'q1' } }),
    completeMint: () => outs.map(proofFor),
  });
  await t.onchain.resume();
  const mintCall = t.calls.find((c) => c.name === 'completeMint')!;
  const atRequest = JSON.parse(mintCall.storage!) as Deposit[];
  assert.equal(atRequest[0].outputs?.length, 2, 'outputs were in localStorage before completeMint');
  assert.equal(atRequest[0].signature, 'sig');
  assert.equal(t.balance(), 3072);
  assert.equal(saved<Deposit>(DEP)[0].state, 'done');
  assert.equal(saved<Deposit>(DEP)[0].outputs, undefined);
});

test('deposit: mint signed but the answer was lost -> NUT-09 restore after reload, counted once', async () => {
  const outs = outputs(4096, 512);
  localStorage.setItem(DEP, JSON.stringify([{ quote: 'q2', amount: 4608, address: 'u', expiry: null, created: 1, state: 'paid', outputs: outs.map((o) => OutputData.serialize(o)), signature: 'sig' } satisfies Deposit]));
  const t = harness({
    checkMintQuote: () => ({ quote: 'q2', amount_paid: 4608, amount_issued: 4608 }),
    restore: ({ outputs: req }: { outputs: Array<{ B_: string }> }) => ({ outputs: req, signatures: req.map(() => ({ id: KEYSET, amount: 0, C_: 'x' })) }),
  });
  await t.onchain.resume();
  assert.equal(t.balance(), 4608);
  assert.equal(saved<Deposit>(DEP)[0].state, 'done');
  await t.onchain.resume(); // a second reload: nothing open, nothing added
  assert.equal(t.balance(), 4608);
  assert.ok(!t.calls.some((c) => c.name === 'completeMint'), 'never minted twice');
});

test('deposit: unpaid past its expiry -> expired, stays listed', async () => {
  localStorage.setItem(DEP, JSON.stringify([{ quote: 'q3', amount: 5000, address: 'u', expiry: 1000, created: 1, state: 'unpaid' } satisfies Deposit]));
  const t = harness({ checkMintQuote: () => ({ quote: 'q3', amount_paid: 0, amount_issued: 0 }) });
  await t.onchain.resume();
  assert.equal(saved<Deposit>(DEP)[0].state, 'expired');
  assert.equal(t.balance(), 0);
});

const pendingWithdrawal = (state: Withdrawal['state'], inputs: Proof[], blanks: OutputData[]): Withdrawal => ({
  quote: 'm1',
  amount: 12000,
  feeReserve: 10000,
  address: 'u',
  created: 1,
  state,
  inputs: JSON.parse(JSON.stringify(inputs)),
  outputs: blanks.map((o) => OutputData.serialize(o)),
});
const inputs = () => outputs(16384, 8192).map(proofFor);

test('withdrawal: saved as sending, melt never reached the mint -> re-sent with the same inputs and blanks', async () => {
  const ins = inputs();
  const blanks = outputs(1, 1, 1);
  localStorage.setItem(WD, JSON.stringify([pendingWithdrawal('sending', ins, blanks)]));
  const t = harness({
    checkMeltQuote: () => ({ quote: 'm1', state: 'UNPAID' }),
    completeMelt: () => ({ quote: { quote: 'm1', state: 'PENDING' }, change: [] }),
  });
  await t.onchain.resume();
  const melt = t.calls.find((c) => c.name === 'completeMelt')!;
  const preview = melt.args[0] as { inputs: Proof[]; outputData: OutputData[] };
  assert.deepEqual(preview.inputs.map((p) => p.secret), ins.map((p) => p.secret));
  assert.deepEqual(preview.outputData.map((o) => o.blindedMessage.B_), blanks.map((o) => o.blindedMessage.B_));
  assert.equal(saved<Withdrawal>(WD)[0].state, 'pending');
  assert.equal(t.balance(), 0, 'inputs stay out of the balance while it is pending');
});

test('withdrawal: paid while away, change missing from the quote -> recovered with NUT-09 restore', async () => {
  const blanks = outputs(1, 1, 1);
  localStorage.setItem(WD, JSON.stringify([pendingWithdrawal('pending', inputs(), blanks)]));
  const t = harness({
    checkMeltQuote: () => ({ quote: 'm1', state: 'PAID', payment_preimage: 'ab'.repeat(32) }),
    restore: ({ outputs: req }: { outputs: Array<{ B_: string }> }) => ({ outputs: req.slice(0, 2), signatures: req.slice(0, 2).map(() => ({ id: KEYSET, amount: 0, C_: 'x' })) }),
  });
  await t.onchain.resume();
  const w = saved<Withdrawal>(WD)[0];
  assert.equal(w.state, 'paid');
  assert.equal(w.txid, 'ab'.repeat(32));
  assert.equal(w.change, 2);
  assert.equal(w.fee, 24576 - 12000 - 2);
  assert.equal(t.balance(), 2);
});

test('withdrawal: failed at the mint, inputs unspent -> returned to the balance', async () => {
  const ins = inputs();
  localStorage.setItem(WD, JSON.stringify([pendingWithdrawal('pending', ins, outputs(1))]));
  const t = harness({
    checkMeltQuote: () => ({ quote: 'm1', state: 'UNPAID' }),
    checkProofsStates: (ps: Proof[]) => ps.map(() => ({ state: 'UNSPENT' })),
  });
  await t.onchain.resume();
  assert.equal(saved<Withdrawal>(WD)[0].state, 'returned');
  assert.equal(t.balance(), 24576);
});

test('withdrawal: still pending at the mint -> left alone, inputs not returned', async () => {
  localStorage.setItem(WD, JSON.stringify([pendingWithdrawal('pending', inputs(), outputs(1))]));
  const t = harness({ checkMeltQuote: () => ({ quote: 'm1', state: 'PENDING' }) });
  await t.onchain.resume();
  assert.equal(saved<Withdrawal>(WD)[0].state, 'pending');
  assert.equal(t.balance(), 0);
});
