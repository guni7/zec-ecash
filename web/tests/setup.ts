// Browser globals the wallet modules use, for Node: localStorage, navigator.onLine, and a
// setInterval that doesn't keep the test process alive (initOnchain starts a poller).
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const g = globalThis as Record<string, unknown>;
g.localStorage = new MemoryStorage();
if (!('navigator' in g) || !g.navigator) g.navigator = { onLine: true };
else Object.defineProperty(g.navigator as object, 'onLine', { value: true, configurable: true });
const realSetInterval = setInterval;
g.setInterval = ((fn: () => void, ms?: number) => {
  const t = realSetInterval(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}) as typeof setInterval;
