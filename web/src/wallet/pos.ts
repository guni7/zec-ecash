// NUT-18 point of sale (crates/pos, proxied at /pos): create a payment request, check it. No DOM.

export type PosRequest = { id: string; request: string; amount: number };

export async function createRequest(amount: number, unit: string, mainnet: boolean): Promise<PosRequest> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Enter a whole number of zat.');
  const base = `${location.origin}/pos`;
  let res: Response;
  try {
    res = await fetch(`${base}/create?amount=${amount}&unit=${unit}`);
  } catch {
    throw new Error(
      mainnet ? `Point of sale unreachable at ${base}. Try again later.` : `Point of sale unreachable at ${base} (is crates/pos running? scripts/devnet-up.sh status).`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; request?: string; error?: string };
  if (!res.ok || !body.id || !body.request) throw new Error(`Point of sale: ${body.error ?? res.status}`);
  return { id: body.id, request: body.request, amount };
}

export async function checkRequest(id: string): Promise<{ state?: string; received?: number }> {
  const r = await fetch(`${location.origin}/pos/check/${encodeURIComponent(id)}`);
  return (await r.json()) as { state?: string; received?: number };
}
