// One history list from the separate records: deposits and withdrawals (onchain.ts), sent tokens
// and receipts (tokens.ts), payment requests (posreq.ts). Pure: the Activity and Home pages
// render it, in the words people use (Add money, Cash out, codes), amounts formatted by the page.
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
  /** A partial payment: the amount the code asked for. */
  of?: number;
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
        paid: ['paid · receiving', 'live'],
        collecting: ['paid · receiving', 'live'],
        collected: ['paid · finishing', 'live'],
        done: ['paid to your code', 'ok'],
      } as const
    )[r.state];
    items.push({
      id: `q:${r.id}`,
      kind: 'request',
      amount: r.collected ?? r.received ?? r.amount,
      at: r.paidAt ?? r.created,
      status: r.error && r.state !== 'done' ? `${status} · retrying` : status,
      tone,
      // Paid but not yet in this wallet: tap to collect.
      pending: r.state === 'paid' || r.state === 'collecting' || r.state === 'collected',
      href: `/receive?r=${encodeURIComponent(r.id)}`,
      title: r.state === 'open' ? 'Asked for payment' : 'Received',
    });
    for (const x of r.extras ?? []) {
      const [xs, xt] = x.refundId
        ? (['refunded', 'muted'] as const)
        : x.state === 'done'
          ? (['in your wallet', 'ok'] as const)
          : (['receiving', 'live'] as const);
      items.push({
        id: `x:${r.id}:${x.n}`,
        kind: 'request',
        amount: x.collected ?? x.received,
        at: x.at,
        status: x.error && x.state !== 'done' ? `${xs} · retrying` : xs,
        tone: xt,
        pending: x.state !== 'done',
        href: `/receive?r=${encodeURIComponent(r.id)}`,
        title: x.kind === 'partial' ? 'Partial payment received' : 'Extra payment received',
        of: x.kind === 'partial' ? r.amount : undefined,
      });
    }
  }
  for (const d of src.deposits) {
    const [status, tone] = (
      {
        unpaid: ['waiting for your payment', 'live'],
        paid: ['confirmed · adding', 'live'],
        expired: ['expired unpaid', 'muted'],
        done: ['added', 'ok'],
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
      title: 'Add money',
    });
  }
  for (const w of src.withdrawals) {
    const [status, tone] = (
      {
        sending: ['sending', 'live'],
        pending: ['keyholders approving', 'live'],
        paid: ['sent', 'ok'],
        returned: ['not sent · money returned', 'bad'],
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
      title: 'Cash out',
    });
  }
  for (const s of src.sent) {
    items.push({
      id: `s:${s.id}`,
      kind: 'send',
      amount: -s.amount,
      at: s.at,
      status: s.request
        ? s.state === 'pending'
          ? 'not delivered yet'
          : 'paid'
        : s.state === 'pending'
          ? s.lockedTo
            ? 'waiting for them · locked'
            : 'waiting for them to scan'
          : s.state === 'received'
            ? 'picked up'
            : 'taken back',
      tone: s.state === 'pending' ? 'live' : s.state === 'reclaimed' ? 'muted' : 'ok',
      pending: s.state === 'pending',
      href: `/send?t=${encodeURIComponent(s.id)}`,
      title: s.request ? 'Paid a code' : 'Sent',
    });
  }
  for (const r of src.received) {
    const status = { online: 'in your wallet', offline: 'received offline · confirming when online', 'redeemed-offline': 'in your wallet (received offline)', reclaim: 'back in your wallet' }[r.how];
    items.push({
      id: `r:${r.id}`,
      kind: 'receive',
      amount: r.amount,
      at: r.at,
      status,
      tone: r.how === 'offline' ? 'live' : 'ok',
      pending: false,
      href: '/receive',
      title: r.how === 'reclaim' ? 'Taken back' : 'Received',
    });
  }
  return items.sort((a, b) => b.at - a.at);
}
