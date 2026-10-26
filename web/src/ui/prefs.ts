// What the pages remember about this person, beside the wallet itself: zats or ZEC first, the
// first-run screen seen, and when a backup was last downloaded. Stored with the wallet's own
// entries (zec-ecash-demo:ui:<mint>), so a backup carries it and a reset clears it.
import { loadJson, saveJson } from '../wallet/core';
import { setZatsFirst } from './words';

export type Prefs = { zatsFirst?: boolean; welcomed?: boolean; backupAt?: number };

export function createPrefs(storeKey: string) {
  let prefs = loadJson<Prefs>(storeKey, {});
  setZatsFirst(!!prefs.zatsFirst);
  return {
    get: (): Readonly<Prefs> => prefs,
    set(patch: Partial<Prefs>) {
      prefs = { ...prefs, ...patch };
      saveJson(storeKey, prefs);
      setZatsFirst(!!prefs.zatsFirst);
    },
  };
}

export type PrefStore = ReturnType<typeof createPrefs>;
