// The wallet's proofs when the same wallet is open in two tabs (one localStorage), and the
// clean-up of proofs the mint says are already spent.
import './setup';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Amount, CheckStateEnum, Wallet, type Proof } from '@cashu/cashu-ts';
import { applyChange, createCore } from '../src/wallet/core';

const MINT = 'https://mint.test/mint';
const p = (secret: string, amount: number): Proof => ({ id: '009a1f293253e41e', amount: Amount.from(amount), secret, C: `02${'c'.repeat(64)}` });
const secrets = (ps: readonly Proof[]) => ps.map((x) => x.secret).sort();
const tab = () => createCore({ mintUrl: MINT, unit: 'zat', mainnet: false });

beforeEach(() => localStorage.clear());

test('applyChange removes by secret and never adds a proof twice', () => {
  const next = applyChange([p('a', 1), p('b', 2)], { remove: [{ secret: 'a' }], add: [p('b', 2), p('c', 4), p('c', 4)] });
  assert.deepEqual(secrets(next), ['b', 'c']);
});

test('a second tab does not bring back proofs the first tab spent', () => {
  const a = tab();
  a.changeProofs({ add: [p('x', 8), p('y', 16)] });
  const b = tab(); // opened now: reads x and y
  a.changeProofs({ remove: [p('x', 8)], add: [p('change', 4)] }); // tab A sends using x
  b.changeProofs({ add: [p('z', 32)] }); // tab B then collects a payment, from its old copy
  assert.deepEqual(secrets(tab().proofs()), ['change', 'y', 'z']);
  assert.equal(b.balance(), 4 + 16 + 32);
});

test('dropSpent removes only the proofs the mint says are spent', async () => {
  const proto = Wallet.prototype as unknown as Record<string, unknown>;
  const saved = { loadMint: proto.loadMint, checkProofsStates: proto.checkProofsStates };
  proto.loadMint = async () => {};
  proto.checkProofsStates = async (ps: Proof[]) => ps.map((x) => ({ Y: x.secret, state: x.secret.startsWith('s') ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT }));
  try {
    const core = tab();
    Object.defineProperty(Wallet.prototype, 'keyChain', { configurable: true, get: () => ({ cache: null }) });
    core.changeProofs({ add: [p('s1', 8), p('ok', 16), p('s2', 2)] });
    assert.equal(await core.dropSpent(), 10);
    assert.deepEqual(secrets(core.proofs()), ['ok']);
    assert.equal(await core.dropSpent(), 0);
  } finally {
    Object.assign(proto, saved);
    delete (Wallet.prototype as unknown as Record<string, unknown>).keyChain;
  }
});
