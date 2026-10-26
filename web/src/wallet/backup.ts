// Backup, restore and reset of everything this browser holds for one mint URL. No DOM.
import { PREFIX, loadJson, reviveProofs, sumAmounts } from './core';

export type Backup = {
  format: 'zec-ecash-web-backup';
  version: 1;
  mintUrl: string;
  network: string;
  createdAt: string;
  /** Every localStorage entry for this mint, by name (proofs, p2pk-key, nut20-key, deposits, ...). */
  entries: Record<string, string>;
};

/** The localStorage names held for `mintUrl` (`zec-ecash-demo:<name>:<mintUrl>`). */
export function entryNames(mintUrl: string): string[] {
  const suffix = `:${mintUrl}`;
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(`${PREFIX}:`) && k.endsWith(suffix)) out.push(k.slice(PREFIX.length + 1, k.length - suffix.length));
  }
  return out.sort();
}

export function makeBackup(mintUrl: string, network: string): Backup {
  const entries: Record<string, string> = {};
  for (const name of entryNames(mintUrl)) entries[name] = localStorage.getItem(`${PREFIX}:${name}:${mintUrl}`)!;
  return { format: 'zec-ecash-web-backup', version: 1, mintUrl, network, createdAt: new Date().toISOString(), entries };
}

/** What a reset or restore would replace: ecash, and anything still moving. */
export function holdings(mintUrl: string) {
  const k = (n: string) => `${PREFIX}:${n}:${mintUrl}`;
  const proofs = sumAmounts(reviveProofs(loadJson(k('proofs'), [])));
  const deposits = loadJson<Array<{ state: string }>>(k('deposits'), []).filter((d) => d.state === 'unpaid' || d.state === 'paid').length;
  const withdrawals = loadJson<Array<{ state: string }>>(k('withdrawals'), []).filter((w) => w.state === 'sending' || w.state === 'pending').length;
  const offline = loadJson<Array<{ amount: number }>>(k('offline-received'), []).reduce((a, p) => a + p.amount, 0);
  const sentPending = loadJson<Array<{ state: string; amount: number }>>(k('sent'), []).filter((s) => s.state === 'pending');
  return { proofs, deposits, withdrawals, offline, sentPending: sentPending.length, empty: proofs === 0 && deposits === 0 && withdrawals === 0 && offline === 0 };
}

/** Restores a backup into an empty wallet only (never merges keys over a wallet holding funds). */
export function restoreBackup(text: string, mintUrl: string, network: string) {
  let b: Backup;
  try {
    b = JSON.parse(text) as Backup;
  } catch {
    throw new Error('That file is not a wallet backup (not JSON).');
  }
  if (b.format !== 'zec-ecash-web-backup' || b.version !== 1 || typeof b.entries !== 'object') throw new Error('That file is not a zec-ecash wallet backup.');
  if (b.mintUrl !== mintUrl) throw new Error(`That backup is for ${b.mintUrl}; this wallet uses ${mintUrl}.`);
  if (b.network !== network) throw new Error(`That backup is from ${b.network}; this is ${network}.`);
  if (!holdings(mintUrl).empty) throw new Error('This wallet holds ecash or open deposits/withdrawals. Restore only into an empty wallet (reset it first, after exporting).');
  for (const name of entryNames(mintUrl)) localStorage.removeItem(`${PREFIX}:${name}:${mintUrl}`);
  for (const [name, value] of Object.entries(b.entries)) localStorage.setItem(`${PREFIX}:${name}:${mintUrl}`, value);
}

/** Deletes everything this browser holds for the mint: ecash, keys, open quotes. Irreversible. */
export function resetWallet(mintUrl: string) {
  for (const name of entryNames(mintUrl)) localStorage.removeItem(`${PREFIX}:${name}:${mintUrl}`);
}
