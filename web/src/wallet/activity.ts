// One history list from the separate records: deposits and withdrawals (onchain.ts), sent tokens
// and receipts (tokens.ts). Pure: the Activity and Home pages render it.
import type { Deposit, Withdrawal } from './onchain';
import type { PosRecord } from './posreq';
import type { Received, SentToken } from './tokens';

export type FeedKind = 'deposit' | 'withdraw' | 'send' | 'receive' | 'request';
export type FeedItem = {
  id: string;
  kind: FeedKind;
  /** Positive: into this wallet; negative: out of it. */
  amount: number;
  at: number;
  status: string;
  tone: 'live' | 'ok' | 'bad' | 'muted';
  /** Still moving: tap to resume (deposit, withdrawal) or reclaim (send). */
  pending: boolean;
  href: string;
  title: string;
};

export function buildFeed(src: {
  deposits: readonly Deposit[];
  withdrawals: readonly Withdrawal[];
  sent: readonly SentToken[];
  received: readonly Received[];
  requests?: readonly PosRecord[];
}): FeedItem[] {
  const items: FeedItem[] = [];
  for (const r of src.requests ?? []) {
    const [status, tone] = (
      {
        open: ['waiting for payment', 'muted'],
        paid: ['paid · collecting', 'live'],
        collecting: ['paid · collecting', 'live'],
        collected: ['collected · finishing', 'live'],
        done: ['collected', 'ok'],
      } as const
    )[r.state];
    items.push({
      id: `q:${r.id}`,
      kind: 'request',
      amount: r.collected ?? r.received ?? r.amount,
      at: r.paidAt ?? r.created,
      status: r.error && r.state !== 'done' ? `${status} · ${r.error}` : status,
      tone,
      // Paid but not yet in this wallet: tap to collect.
      pending: r.state === 'paid' || r.state === 'collecting' || r.state === 'collected',
      href: `/request?r=${encodeURIComponent(r.id)}`,
      title: 'Request',
    });
    for (const x of r.extras ?? []) {
      const [xs, xt] = x.refundId
        ? (['refunded', 'muted'] as const)
        : x.state === 'done'
          ? (['in your wallet', 'ok'] as const)
          : (['collecting', 'live'] as const);
      items.push({
        id: `x:${r.id}:${x.n}`,
        kind: 'request',
        amount: x.collected ?? x.received,
        at: x.at,
        status: x.error && x.state !== 'done' ? `${xs} · ${x.error}` : xs,
        tone: xt,
        pending: x.state !== 'done',
        href: `/request?r=${encodeURIComponent(r.id)}`,
        title:
          x.kind === 'partial'
            ? `Partial payment received: ${x.received.toLocaleString('en-US')} of ${r.amount.toLocaleString('en-US')} zat`
            : `Extra payment received: ${x.received.toLocaleString('en-US')} zat`,
      });
    }
  }
  for (const d of src.deposits) {
    const [status, tone] = (
      {
        unpaid: ['awaiting payment', 'live'],
        paid: ['minting', 'live'],
        expired: ['expired', 'muted'],
        done: ['minted', 'ok'],
      } as const
    )[d.state];
    items.push({
      id: `d:${d.quote}`,
      kind: 'deposit',
      amount: d.state === 'done' ? (d.minted ?? d.amount) : d.amount,
      at: d.created,
      status,
      tone,
      pending: d.state === 'unpaid' || d.state === 'paid',
      href: `/deposit?q=${encodeURIComponent(d.quote)}`,
      title: 'Deposit',
    });
  }
  for (const w of src.withdrawals) {
    const [status, tone] = (
      {
        sending: ['sending', 'live'],
        pending: ['pending', 'live'],
        paid: ['paid', 'ok'],
        returned: ['not sent · returned', 'bad'],
      } as const
    )[w.state];
    items.push({
      id: `w:${w.quote}`,
      kind: 'withdraw',
      amount: -(w.state === 'paid' ? w.amount + (w.fee ?? 0) : w.amount),
      at: w.created,
      status,
      tone,
      pending: w.state === 'sending' || w.state === 'pending',
      href: `/withdraw?q=${encodeURIComponent(w.quote)}`,
      title: 'Withdraw',
    });
  }
  for (const s of src.sent) {
    items.push({
      id: `s:${s.id}`,
      kind: 'send',
      amount: -s.amount,
      at: s.at,
      status: s.state === 'pending' ? (s.lockedTo ? 'not redeemed yet · locked' : 'not redeemed yet') : s.state,
      tone: s.state === 'pending' ? 'live' : s.state === 'reclaimed' ? 'muted' : 'ok',
      pending: s.state === 'pending',
      href: `/send?t=${encodeURIComponent(s.id)}`,
      title: s.lockedTo ? 'Sent (locked)' : 'Sent',
    });
  }
  for (const r of src.received) {
    const status = { online: 'redeemed', offline: 'accepted offline', 'redeemed-offline': 'redeemed (was offline)', reclaim: 'reclaimed' }[r.how];
    items.push({
      id: `r:${r.id}`,
      kind: 'receive',
      amount: r.amount,
      at: r.at,
      status,
      tone: r.how === 'offline' ? 'live' : 'ok',
      pending: false,
      href: '/receive',
      title: r.how === 'reclaim' ? 'Reclaimed' : 'Received',
    });
  }
  return items.sort((a, b) => b.at - a.at);
}
