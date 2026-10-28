# Mainnet evidence

Real transactions from the mainnet mint at https://zecmint.duckdns.org. Each one can be checked
by anyone with a block explorer. The reserve's deposits and cash-outs are shielded (Ironwood), so
an explorer shows that a transaction exists and where it was mined, not its amounts or addresses.

TODO(evidence): fill in every row below.

## Deposits

| Date (UTC) | Amount (zats) | Txid | Block height | Confirmed at depth 10 |
|---|---|---|---|---|
| TODO(evidence) | TODO(evidence) | [TODO(evidence)](https://blockchair.com/zcash/transaction/TODO) | TODO(evidence) | TODO(evidence) |

## Cash-outs (signed 2-of-3 with FROST)

| Date (UTC) | Amount (zats) | Fee (zats) | Guardians that signed | Txid | Block height |
|---|---|---|---|---|---|
| TODO(evidence) | TODO(evidence) | TODO(evidence) | TODO(evidence) | [TODO(evidence)](https://blockchair.com/zcash/transaction/TODO) | TODO(evidence) |

The explorer links use the same format as the web wallet's "View on the blockchain" button
(`https://blockchair.com/zcash/transaction/<txid>`).

## Reserve snapshots

`curl -s https://zecmint.duckdns.org/reserves`, taken at the times below. `ok: true` means the
confirmed reserve covers all outstanding ecash plus cash-outs in flight.

### TODO(evidence): date and time (UTC)

```json
TODO(evidence): paste the /reserves response
```

### TODO(evidence): date and time (UTC), after a cash-out

```json
TODO(evidence): paste the /reserves response
```

## Ironwood

Ironwood (NU6.3) activated on mainnet at block 3,428,143. The reserve wallet and every cash-out
use Orchard-format receivers, which pay into the Ironwood pool.

TODO(evidence): the height of the first deposit after activation, to show it landed in Ironwood.
