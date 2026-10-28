# zec-processor: settings and behaviour

The processor is the Zcash side of the mint. It implements CDK's `MintPayment` trait and serves
it to stock `cdk-mintd` 0.18.2 over gRPC (`backend = "grpcprocessor"`). Its reserve wallet is
view-only; withdrawals are signed 2-of-3 by the FROST guardians. Overview:
[README › How it works](../README.md#how-it-works).

## Settings

Environment, or `.env` in the repo root on the devnet (`mainnet/.env` only on mainnet). Regtest
defaults shown; [Mainnet differences](#mainnet-differences) lists what changes there.

    ZEC_NETWORK=regtest                       # regtest | mainnet; from the real environment only
    ZEC_LWD_URL=http://127.0.0.1:9067         # light-wallet gRPC; https:// uses TLS (old name ZEC_LIGHTWALLETD)
    ZEC_MINT_UFVK=devnet/keys/mint.ufvk       # view-only reserve key; startup fails if missing
    ZEC_MINT_DB=devnet/mint-reserve.sqlite
    ZEC_FROST_PUBKEYS=devnet/keys/frost-pubkeys.json   # startup fails if missing
    ZEC_GUARDIANS=http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103
    ZEC_GUARDIAN_TIMEOUT_SECS=30              # per FROST round
    ZEC_PROCESSOR_DB=devnet/processor.sqlite  # quote table zec_deposit_address
    ZEC_GRPC_ADDR=127.0.0.1:50051
    ZEC_MIN_CONFIRMATIONS=1                   # deposit PAID / withdrawal settled at this depth (default 1 on regtest, 10 elsewhere)
    ZEC_MIN_ZATS=1000                         # keep equal to min_mint/max_mint in mintd/config.toml
    ZEC_MAX_ZATS=100000000000
    ZEC_SYNC_INTERVAL_SECS=7
    ZEC_CDK_MINT_DB=devnet/mint/cdk-mintd.sqlite   # read-only: issued/redeemed for the reserve check
    ZEC_STATUS_ADDR=127.0.0.1:8095            # GET /reserves, /deposit-quote, /withdrawal-quote (also proxied at https://<host>:5173/...)
    ZEC_MAX_RESERVE=1000000                   # refuse deposit quotes that could push the reserve past this (zats)

- The processor speaks plaintext gRPC, so mintd needs `allow_insecure = true`; keep both on loopback.
- zec-processor builds the Orchard proving key at startup (about 30 s in a debug build).
- After changing `mintd/config.toml`, run `cdk-mintd -w devnet/mint config apply --file mintd/config.toml`.
  Use only `devnet/mint` as the mint's work dir: a second mint database on the same URL has
  different keysets, and wallets that used one fail against the other ("Unknown Keyset").

## Status endpoints

Plain HTTP on `ZEC_STATUS_ADDR` (loopback); Caddy, or the Vite dev server on the devnet, serves
them over HTTPS on the wallet's own origin.

- `GET /reserves`: the reserve check below, plus whether each guardian answers (id, up, key
  check, last seen; no URLs or error text). 200 when it holds, 503 when violated or not yet
  checked, or when a withdrawal needs an operator.
- `GET /deposit-quote?amount=<zat>`: whether a deposit quote would be accepted (limits, the
  reserve check, the `ZEC_MAX_RESERVE` cap), and if not, why. `?quote=<id>`: an open deposit's
  progress (zats received, confirmations so far and needed).
- `GET /withdrawal-quote?amount=<zat>&address=<ua>`: whether a withdrawal can be quoted: 200
  `{"ok":true,"fee":...}` or 422 with a `code` (`insufficient_reserve`, `invalid_address`,
  `amount_out_of_range`, `fee_estimate_failed`) and the message.

Why the last one exists: cdk-mintd 0.18.2 reports *every* failed `zec` melt quote to the wallet as
"Unit unsupported" (`get_melt_custom_quote_impl` maps any backend error to `UnsupportedUnit`,
and cdk-payment-processor's gRPC server has already replaced our message with "Could not get
quote"). Stock mintd can't carry the reason, so the processor serves it. `zec-ecash-cli
withdraw` asks it when a quote fails and prints e.g. "insufficient reserve: the mint can spend
275000 zat right now ..., and this withdrawal needs 5020000 zat including the fee". The CLI finds
both status endpoints from the mint URL (override with `ZEC_STATUS_URL`). The web wallet asks
too.

Operator-only details (a flagged withdrawal's address, txid and reason) are never served over
HTTP: `zec-processor operator-actions` prints them on the host.

## Reserve invariant

Checked after every sync: confirmed reserve >= outstanding ecash + withdrawals in flight.
`zec-ecash-cli reserves` prints the numbers (exit 1 if violated); `GET /reserves` returns them as
JSON. While it is violated the processor logs `RESERVE INVARIANT VIOLATED` (once a minute) and
refuses new deposit quotes; the mint reports that only as "Invalid payment request", so the CLI
checks `/reserves` and says why.

- **Confirmed reserve:** shielded notes at `ZEC_MIN_CONFIRMATIONS` depth (dust included,
  immature coinbase not), plus the mint's own change from mined withdrawals at any depth; a note
  that a not-yet-mined withdrawal spends still counts (it is still on chain).
- **Outstanding:** cdk-mintd's issued - redeemed (`keyset_amounts`, unit zat) - melt inputs still
  PENDING.
- **In flight:** amount + fee of withdrawals whose transaction is not mined yet.

With these, a withdrawal never trips the check: when it is broadcast its ecash moves from
outstanding to in flight, and when it is mined it leaves the reserve and in flight together.
Raising `ZEC_MIN_CONFIRMATIONS` can trip it until recent deposits are that deep (a real
shortfall in *confirmed* reserve).

The reserve cap (`ZEC_MAX_RESERVE`, default 1,000,000 zat) refuses deposit quotes that could
push the reserve past it, counting open quotes; `GET /deposit-quote?amount=` says why.

## Withdrawals

- Withdrawals pay only unified addresses with an Orchard receiver (they land in Ironwood);
  transparent, TEX and Sapling-only addresses are rejected at quote time.
- Signing: `make_payment` builds the PCZT and returns Pending; FROST signing runs in the
  background (the mint locks the quote during `make_payment`, and guardians read the quote from
  the mint before signing). Fewer than 2 guardians, or a refusal, means FAILED with nothing
  broadcast, and the mint refunds.
- Each guardian re-checks the withdrawal itself before signing (`crates/guardian/src/policy.rs`,
  checks a-h; listed in the [README](../README.md#cash-out)).
- A withdrawal reports Pending from the moment its transaction is built until it is mined, and
  Failed only if it was never broadcast or expired unmined, because the mint refunds the ecash
  on Failed. The txid is saved before the transaction is sent. State lives in `zec_withdrawal`
  in `devnet/processor.sqlite`; after a crash the processor fails unbroadcast withdrawals and
  rebroadcasts broadcast ones.
- Settlement events for withdrawals finished in the last day are replayed whenever the mint
  (re)opens the event stream, so an event sent while the mint was disconnected is not lost.
- **Reorgs:** each pass asks the light-wallet server (not the wallet, which notices a reorg only
  once the new chain is longer) which block each withdrawal's tx is in, and records its height
  and hash. If that block is replaced and the tx is no longer mined, the record is cleared, a
  `REORG` warning is logged, and the withdrawal stays Pending and is rebroadcast (zebrad does not
  put transactions from a dropped block back in its mempool). It settles PAID only once the block
  it is in now is `ZEC_MIN_CONFIRMATIONS` deep. A withdrawal already PAID stays watched for 100
  blocks; if its block disappears it is logged as `REORG AFTER PAID` and rebroadcast (the mint
  can't undo PAID, so raise the depth). If such a withdrawal also passes its expiry height
  without being mined again, it can never be mined: the processor logs `CRITICAL` with the quote
  id, amount and address, stops watching and retrying it, and lists it on `/reserves` (state
  `operator_action_required`, HTTP 503; `zec-ecash-cli reserves` prints it and exits 1). Pay the
  recipient by other means, then `cargo run -p zec-processor -- resolve <quote_id>`.
  Try reorgs on the devnet: `curl -s 127.0.0.1:18232 -d '{"method":"invalidateblock","params":["<hash>"]}'`.
- Chain access: the processor and wallets use only the light-wallet gRPC (GetLatestBlock,
  GetTransaction, GetBlock, SendTransaction, GetTreeState), so a remote light-wallet server is
  enough. zebrad's JSON-RPC is used only for regtest mining (`devnet/mine.sh`) and the reorg test
  above; `devnet-up.sh` reads the tip with `devwallet tip`.

## Mainnet differences

`ZEC_NETWORK=mainnet` switches every binary to Zcash mainnet. Only the network parameters and
the defaults below differ; every code path is the same as on regtest, which stays the default.
`ZEC_NETWORK` is read from the real environment only, never from a `.env` file.

| | regtest | MAINNET |
|---|---|---|
| state (keys, DBs, mint work dir, logs) | `devnet/` | `mainnet/` (gitignored) |
| settings file | `.env` + shell | `mainnet/.env` only (never `.env` or the shell, which may hold the devnet's) |
| light-wallet server (`ZEC_LWD_URL`) | `http://127.0.0.1:9067` (Zebra) | `https://zec.rocks:443` (TLS, webpki roots) |
| `ZEC_MIN_CONFIRMATIONS` | 1 | 10 |
| new wallet / UFVK birthday | block 2 | chain tip - 100 (stored in the wallet DB) |
| ports: mintd, processor gRPC, status, guardians, POS | 8085, 50051, 8095, 7101-3, 8090 | +1000: 9085, 51051, 9095, 8101-3, 9090 |
| mintd config | `mintd/config.toml` | `mintd/config.mainnet.toml` (min deposit/withdrawal 10,000 zat: smaller notes are dust) |
| guardian transport | plain HTTP on loopback (TLS/auth only if configured) | TLS (`scripts/guardian-ca.sh`) and HMAC-authenticated rounds (`guardian make-auth-key`), both required |
| start | `scripts/devnet-up.sh` | systemd units in `deploy/systemd/` (`zec-processor`, `zec-mintd`, `zec-guardian@N`; env from `deploy/mainnet.env.example` / `deploy/guardian.env.example`), or `scripts/mainnet-up.sh`; `scripts/server-check.sh` on every box |
| web wallet | Vite dev server, port 5173 | MAINNET badge; disabled unless opened at `ZEC_MINT_URL`; built and served by Caddy (`deploy/Caddyfile.example`) |
| keys | `scripts/devnet-reset.sh --new-keys` (runs `scripts/devnet-dkg.sh`) | distributed ceremony, one guardian per machine ([deploy-mainnet.md](deploy-mainnet.md)) |

- Labels: on mainnet every log line starts with `MAINNET`, every binary prints a
  `*** MAINNET (real ZEC) ***` banner, and `devwallet send` / `zec-ecash-cli withdraw` refuse
  unless given `--confirm-mainnet`.
- Keys come from a distributed DKG: each guardian runs
  `guardian dkg --id N --threshold 2 --participants 3` on its own machine (again after each
  delivery), the operator carries the round-1 files to everyone and each round-2 file only to its
  recipient, the processor host makes `mint.ufvk` from `frost-pubkeys.json`, and
  `guardian verify` checks all three machines agree. Each guardian writes only its own key share
  (mode 600) and the public key package. `scripts/devnet-dkg.sh` runs the same ceremony on one
  machine for the devnet only and refuses `ZEC_NETWORK=mainnet`.
- Guardian transport: a guardian's `/round1` and `/round2` take only requests carrying an
  HMAC-SHA256 (per-guardian secret shared with the processor only) over method, path, timestamp
  and body, within 60 s and never replayed; the check runs before any nonce is made. On mainnet
  the guardian serves TLS with a certificate from the operator's private CA (the processor trusts
  it as `ZEC_GUARDIAN_CA`) and checks quotes at the mint's public `https://` URL.
- Devnet scripts pin `ZEC_NETWORK=regtest` and stop processes by their devnet ports, so they
  never stop a mainnet process; `devnet-reset.sh` never touches `mainnet/`.
- Seeds and keys are never generated implicitly; seed files are created mode 600.

Dry check (moves nothing):

    ZEC_NETWORK=mainnet cargo run -p devwallet -- info     # server, tip, branch; Ironwood active?
    ZEC_NETWORK=mainnet cargo run -p devwallet -- --seed mainnet/keys/dry-check-wallet.seed new
    ZEC_NETWORK=mainnet cargo run -p devwallet -- --seed mainnet/keys/dry-check-wallet.seed sync

`mainnet/.env` holds `CDK_MINTD_MNEMONIC` (the mainnet mint's own, never the devnet's),
`ZEC_MINT_URL`, `ZEC_MINT_CA` (if needed), and any `ZEC_*` overrides.

## Version notes

- `orchard` is pinned to `=0.15.5`; 0.16 conflicts with `zcash_primitives` 0.30.
- Enabling `pczt` on `zcash_client_backend` turns on transparent inputs, so
  `zcash_client_sqlite` needs `transparent-inputs` too.
- Ironwood support is behind the `orchard` feature; there is no `ironwood` feature.
- Why the mint is a separate process: `cdk-sqlite` / `cdk-axum` and the Zcash crates conflict
  (`libsqlite3-sys`, `sha2`), so they can't share one Cargo resolve. The wallet CLI uses
  `cdk-redb` for the same reason.
