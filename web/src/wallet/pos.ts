// NUT-18 point of sale (crates/pos, proxied at /pos): health, create a payment request, check it.
// No DOM. Any answer that isn't the POS's own JSON (a proxy's 502/503/504, an HTML error page)
// means the point of sale is offline.

export type PosRequest = { id: string; request: string; amount: number };

export const POS_OFFLINE = 'Point of sale is offline. Payment requests can’t be created right now; try again later.';

export class PosOfflineError extends Error {
  constructor() {
    super(POS_OFFLINE);
  }
}

const base = () => `${location.origin}/pos`;

/** The POS's JSON body, or PosOfflineError for anything that didn't come from the POS itself. */
async function posJson<T>(path: string, timeoutMs = 8000): Promise<{ res: Response; body: T }> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new PosOfflineError();
  }
  if (res.status >= 500) throw new PosOfflineError();
  try {
    return { res, body: (await res.json()) as T };
  } catch {
    throw new PosOfflineError();
  }
}

/** true if the point of sale answers its health check. */
export async function posOnline(): Promise<boolean> {
  try {
    const { res, body } = await posJson<{ ok?: boolean }>('/health', 4000);
    return res.ok && body.ok === true;
  } catch {
    return false;
  }
}

export async function createRequest(amount: number, unit: string): Promise<PosRequest> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
  const { res, body } = await posJson<{ id?: string; request?: string; error?: string }>(`/create?amount=${amount}&unit=${unit}`);
  if (!res.ok || !body.id || !body.request) throw new Error(`Point of sale: ${body.error ?? `HTTP ${res.status}`}`);
  return { id: body.id, request: body.request, amount };
}

export async function checkRequest(id: string): Promise<{ state?: string; received?: number }> {
  return (await posJson<{ state?: string; received?: number }>(`/check/${encodeURIComponent(id)}`)).body;
}
