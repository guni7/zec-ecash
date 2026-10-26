// The wallet's shared state: proofs (localStorage, per mint URL), the cashu-ts Wallet, this
// browser's P2PK key, settings, and a tiny event bus the UI listens to. No DOM.
//
// Storage keys are `zec-ecash-demo:<name>:<mint URL>`, unchanged from the single-page wallet,
// so an existing browser keeps its proofs, keys and open deposits/withdrawals.
import { Amount, MintOperationError, NetworkError, Wallet, type KeyChainCache, type Proof } from '@cashu/cashu-ts';
import { loadOrCreateKey } from './offline';

export const PREFIX = 'zec-ecash-demo';
/** NUT error code the mint returns for a proof that was already spent. */
export const ALREADY_SPENT = 11001;

export type Settings = { compact: boolean };
export type Tone = 'ok' | 'bad' | '';
export type Event = { type: 'balance' } | { type: 'say'; text: string; tone: Tone } | { type: 'mint'; up: boolean } | { type: 'sent' } | { type: 'activity' };

export function storeKey(name: string, mintUrl: string) {
  return `${PREFIX}:${name}:${mintUrl}`;
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function reviveProofs(raw: unknown): Proof[] {
  return (Array.isArray(raw) ? raw : []).map((p: Proof & { amount: string }) => ({ ...p, amount: Amount.from(p.amount) }));
}

export const sumAmounts = (ps: Array<{ amount: unknown }>) => ps.reduce((a, p) => a + Number(String(p.amount ?? 0)), 0);

export type MintInfo = {
  name?: string;
  description?: string;
  nuts?: Record<string, { methods?: Array<{ method: string; unit: string; min_amount?: number; max_amount?: number }>; supported?: unknown }>;
};

export function createCore(opts: { mintUrl: string; unit: string; mainnet: boolean }) {
  const { mintUrl, unit, mainnet } = opts;
  const key = (name: string) => storeKey(name, mintUrl);
  const listeners = new Set<(e: Event) => void>();
  const emit = (e: Event) => listeners.forEach((l) => l(e));

  let proofs = reviveProofs(loadJson(key('proofs'), []));
  let wallet: Wallet | null = null;
  let info: MintInfo | null = null;
  let mintUp: boolean | null = null;
  /** This wallet's P2PK key: senders lock tokens to the public half, so they're safe to accept offline. */
  const me = loadOrCreateKey(key('p2pk-key'));
  let settings: Settings = { compact: true, ...loadJson<Partial<Settings>>(key('settings'), {}) };

  function isNetworkError(e: unknown) {
    return !navigator.onLine || e instanceof NetworkError || e instanceof TypeError;
  }

  /** Turns any failure into a sentence a person can act on. */
  function explain(e: unknown): string {
    if (e instanceof MintOperationError) {
      if (e.code === ALREADY_SPENT || /already spent/i.test(e.message)) return 'Already spent: this token was redeemed before.';
      return `The mint refused: ${e.message}`;
    }
    if (e instanceof NetworkError || e instanceof TypeError) {
      return mainnet
        ? `Mint unreachable at ${mintUrl}. Check your connection and try again; if it persists, the mint may be down for maintenance. Your ecash stays in this browser.`
        : `Mint unreachable at ${mintUrl}. Is the devnet (scripts/devnet-up.sh) and the web server running?`;
    }
    return e instanceof Error ? e.message : String(e);
  }

  function setMintUp(up: boolean) {
    if (mintUp === up) return;
    mintUp = up;
    emit({ type: 'mint', up });
  }

  async function connect(): Promise<Wallet> {
    if (wallet) return wallet;
    // denominationTarget 0: split every mint/swap/receive/send into the minimal powers of two
    // (cashu-ts defaults to keeping 3 proofs of each denomination, which bloats tokens and QRs).
    const w = new Wallet(mintUrl, { unit, denominationTarget: 0 });
    try {
      await w.loadMint();
    } catch (e) {
      if (isNetworkError(e)) setMintUp(false);
      throw e;
    }
    // Keep the mint's keys for offline DLEQ checks (verifyOffline).
    saveJson(key('keychain'), w.keyChain.cache);
    wallet = w;
    setMintUp(true);
    return w;
  }

  async function loadInfo(): Promise<MintInfo> {
    try {
      const res = await fetch(`${mintUrl}/v1/info`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = (await res.json()) as MintInfo;
      setMintUp(true);
      return info;
    } catch (e) {
      setMintUp(false);
      throw e instanceof Error && !(e instanceof MintOperationError) ? new TypeError(e.message) : e;
    }
  }

  return {
    mintUrl,
    unit,
    mainnet,
    me,
    key,
    connect,
    loadInfo,
    info: () => info,
    mintUp: () => mintUp,
    setMintUp,
    explain,
    isNetworkError,
    proofs: () => proofs,
    balance: () => Number(Amount.sum(proofs.map((p) => p.amount)).toString()),
    setProofs(next: Proof[]) {
      proofs = next;
      // Amount serializes to a string (Amount.toJSON); reviveProofs turns it back into an Amount.
      saveJson(key('proofs'), proofs);
      emit({ type: 'balance' });
    },
    cachedKeychain: () => loadJson<KeyChainCache | null>(key('keychain'), null),
    settings: () => settings,
    setSettings(patch: Partial<Settings>) {
      settings = { ...settings, ...patch };
      saveJson(key('settings'), settings);
    },
    say: (text: string, tone: Tone = '') => emit({ type: 'say', text, tone }),
    emit,
    on(fn: (e: Event) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Core = ReturnType<typeof createCore>;
