// zec-processor's public status endpoints (same origin, proxied): the reserve check with guardian
// health, and a deposit quote's confirmation progress. No DOM.

export type Guardian = { id: number; up: boolean; key_ok: boolean; last_seen: number | null };
export type Reserves = {
  state: 'ok' | 'violated' | 'operator_action_required' | 'unknown';
  reserve_zats?: number;
  required_zats?: number;
  outstanding_zats?: number;
  in_flight_zats?: number;
  shortfall_zats?: number;
  chain_height?: number;
  min_confirmations?: number;
  checked_at?: number;
  ledger?: { issued: number; redeemed: number; pending_melt: number };
  /** Public: quote id, amount and when it was flagged only (details stay on the mint host). */
  operator_action?: Array<{ quote_id: string; amount_zats: number; flagged_at: number }>;
  guardians: Guardian[];
  guardians_checked_at?: number;
  error?: string;
};

export async function fetchReserves(): Promise<Reserves> {
  const res = await fetch('/reserves', { cache: 'no-store' });
  const body = (await res.json()) as Partial<Reserves>;
  return { guardians: [], state: 'unknown', ...body } as Reserves;
}

export type DepositProgress = { received_zats: number; confirmations: number; required_confirmations: number; paid: boolean };

/** null if the processor doesn't know the quote (or is unreachable). */
export async function depositProgress(quote: string): Promise<DepositProgress | null> {
  try {
    const res = await fetch(`/deposit-quote?quote=${encodeURIComponent(quote)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as DepositProgress;
  } catch {
    return null;
  }
}

/** Segments of a `n`-segment bar to fill for `got` of `need` confirmations. */
export function filledSegments(got: number, need: number, n = 10): number {
  if (need <= 0) return n;
  return Math.max(0, Math.min(n, Math.floor((Math.min(got, need) / need) * n)));
}
