# zec-ecash

A Cashu ecash mint for ZEC: stock `cdk-mintd` plus our `zec-processor` over CDK's gRPC
payment-processor API. Reserves sit in the Ironwood shielded pool; withdrawals are
signed 2-of-3 with FROST (RedPallas). Runs on a local regtest devnet by default; mainnet
support is experimental (see "Mainnet").

## Prerequisites
- Rust stable (`rustup`), and `protoc`: `apt-get install protobuf-compiler` or `brew install protobuf`

## Build and test
    cargo build
    cargo test --workspace
    cargo clippy --workspace && cargo fmt --all

## Run the mint (separate process; it can't live in this workspace)
Phase 1 is ZEC deposits: a mint quote gets a fresh address of the mint's reserve wallet,
zec-processor watches for the payment, and the mint issues ecash. Phase 2 is withdrawals: a
melt sends ZEC from the Ironwood reserves to a shielded address. Phase 4: withdrawals are
authorized by 2-of-3 FROST guardians; zec-processor's reserve wallet is view-only (a UFVK
whose Orchard `ak` is the guardians' group key) and no process holds the whole spend key.
The whole devnet (node, guardians, processor, mint) is started by `scripts/devnet-up.sh`;
see "Local devnet" below. Then:

    curl -s 127.0.0.1:8085/v1/info                      # nut04 lists method "zec", unit "zat"
    cargo run -p zec-ecash-cli -- deposit 50000         # prints an address, waits, mints
    cargo run -p devwallet -- send <that address> 50000 && ./devnet/mine.sh 1

    cargo run -p zec-ecash-cli -- withdraw 20000 $(cargo run -q -p devwallet -- address)
    ./devnet/mine.sh 1                                   # the CLI prints PAID and the txid

After changing `mintd/config.toml`, run `cdk-mintd -w devnet/mint config apply --file mintd/config.toml`.
Use only `devnet/mint` as the mint's work dir: a second mint database on the same URL has
different keysets, and wallets that used one fail against the other ("Unknown Keyset").

zec-processor settings (environment, or `.env` in the repo root; regtest defaults shown;
see "Mainnet" for how they change there):

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
- Failed withdrawal quotes: cdk-mintd 0.18.2 reports *every* failed `zec` melt quote to the
  wallet as "Unit unsupported" (`get_melt_custom_quote_impl` maps any backend error to
  `UnsupportedUnit`, and cdk-payment-processor's gRPC server has already replaced our message
  with "Could not get quote"). Stock mintd can't carry the reason, so the processor serves it:
  `GET /withdrawal-quote?amount=<zat>&address=<ua>` answers 200 `{"ok":true,"fee":...}` or 422
  with a `code` (`insufficient_reserve`, `invalid_address`, `amount_out_of_range`,
  `fee_estimate_failed`) and the message. `zec-ecash-cli withdraw` asks it when a quote fails,
  and prints e.g. "insufficient reserve: the mint can spend 275000 zat right now ..., and this
  withdrawal needs 5020000 zat including the fee". The CLI finds both status endpoints from the
  mint URL (override with `ZEC_STATUS_URL`).
- Reserve invariant, checked after every sync: confirmed reserve >= outstanding ecash + withdrawals
  in flight. `cargo run -p zec-ecash-cli -- reserves` prints the numbers (exit 1 if violated);
  `GET /reserves` returns them as JSON (200 ok, 503 violated or not yet checked). While it is
  violated the processor logs `RESERVE INVARIANT VIOLATED` (once a minute) and refuses new
  deposit quotes; the mint reports that only as "Invalid payment request", so the CLI checks
  `/reserves` and says why. The figures:
  - confirmed reserve: shielded notes at `ZEC_MIN_CONFIRMATIONS` depth (dust included, immature
    coinbase not), plus the mint's own change from mined withdrawals at any depth; a note that a
    not-yet-mined withdrawal spends still counts (it is still on chain).
  - outstanding: cdk-mintd's issued - redeemed (`keyset_amounts`, unit zat) - melt inputs still
    PENDING.
  - in flight: amount + fee of withdrawals whose transaction is not mined yet.

  With these, a withdrawal never trips the check: when it is broadcast its ecash moves from
  outstanding to in flight, and when it is mined it leaves the reserve and in flight together.
  Raising `ZEC_MIN_CONFIRMATIONS` can trip it until recent deposits are that deep (a real
  shortfall in *confirmed* reserve).
- Withdrawals pay only unified addresses with an Orchard receiver (they land in Ironwood);
  transparent and Sapling-only addresses are rejected at quote time.
- A withdrawal reports Pending from the moment its transaction is built until it is mined, and
  Failed only if it was never broadcast or expired unmined, because the mint refunds the ecash
  on Failed. State lives in `zec_withdrawal` in `devnet/processor.sqlite`; after a crash the
  processor fails unbroadcast withdrawals and rebroadcasts broadcast ones.
- Reorgs: each pass asks the node (not the wallet, which notices a reorg only once the new chain
  is longer) which block each withdrawal's tx is in, and records its height and hash. If that
  block is replaced and the tx is no longer mined, the record is cleared, a `REORG` warning is
  logged, and the withdrawal stays Pending and is rebroadcast (zebrad does not put transactions
  from a dropped block back in its mempool). It settles PAID only once the block it is in now is
  `ZEC_MIN_CONFIRMATIONS` deep. A withdrawal already PAID stays watched for 100 blocks; if its
  block disappears it is logged as `REORG AFTER PAID` and rebroadcast (the mint can't undo PAID,
  so raise the depth). If such a withdrawal also passes its expiry height without being mined
  again, it can never be mined: the processor logs `CRITICAL` with the quote id, amount and
  address, stops watching and retrying it, and lists it on `/reserves` (state
  `operator_action_required`, HTTP 503; `zec-ecash-cli reserves` prints it and exits 1). Pay
  the recipient by other means, then `cargo run -p zec-processor -- resolve <quote_id>`.
  Try reorgs on the devnet: `curl -s 127.0.0.1:18232 -d '{"method":"invalidateblock","params":["<hash>"]}'`.
- Chain access: the processor and wallets use only the light-wallet gRPC (GetLatestBlock,
  GetTransaction, GetBlock, SendTransaction), so a remote lightwalletd is enough. zebrad's
  JSON-RPC is used only for regtest mining (`devnet/mine.sh`) and the reorg test above;
  `devnet-up.sh` reads the tip with `devwallet tip`.
- zec-processor builds the Orchard proving key at startup (about 30 s in a debug build).
- Signing: `make_payment` builds the PCZT and returns Pending; FROST signing runs in the
  background (the mint locks the quote during `make_payment`, and guardians read the quote
  from the mint before signing). Fewer than 2 guardians, or a refusal, means FAILED with
  nothing broadcast, and the mint refunds.
- Each guardian re-checks the withdrawal itself before signing: the mint says the melt is
  PENDING; exactly one output pays the quoted amount to the quoted address; all other value
  returns to the mint; every spend is the mint's; the fee fits the reserve; and it never signs
  two different transactions for one quote.

## Ecash wallets: CLI and web page (Phase 3)
Both are demo wallets for this regtest devnet. Don't use real funds.

    cargo run -p zec-ecash-cli -- init                     # once per wallet (seed in devnet/keys/)
    cargo run -p zec-ecash-cli -- --wallet bob init        # a second wallet, "bob"
    cargo run -p zec-ecash-cli -- send 5000                # cashuB token + terminal QR
    cargo run -p zec-ecash-cli -- --wallet bob receive <token>
    cargo run -p zec-ecash-cli -- --wallet bob pubkey      # P2PK key (derived from the seed)
    cargo run -p zec-ecash-cli -- send 5000 --lock <bob's pubkey>   # only bob can redeem it
    cargo run -p zec-ecash-cli -- send 3000 --dleq        # keep DLEQ proofs (default is compact)
    cargo run -p zec-ecash-cli -- --wallet bob check <token>   # offline: verify every proof's DLEQ
    cargo run -p zec-ecash-cli -- pay <creqA...>          # pay a NUT-18 request (point of sale)
    cargo run -p zec-ecash-cli -- consolidate             # swap all proofs into the minimal set
    cargo run -p zec-ecash-cli -- pending                 # your tokens nobody redeemed yet
    cargo run -p zec-ecash-cli -- reclaim <id>            # take one back (voids that token)

Wallets keep the minimal set of proofs (powers of two) for every mint, swap, send and receive,
so a token holds one proof per set bit of its amount: 3000 zat = 7 proofs, about 1,160
characters compact (the default) or 2,170 with DLEQ proofs (`--dleq`). The web page does the
same; its "Compact token" box is on by default. P2PK-locked sends (`--lock`) always include
DLEQ proofs, because the receiver needs them to accept the token offline.

**Safe offline receive.** Without the mint a receiver can't know a token is unspent, unless
nobody else *can* spend it. So a token is accepted offline only if every proof is P2PK-locked to
the receiver's key (no refund/locktime/multisig escape hatch) and every proof's DLEQ proof checks
out against mint keys cached while online. `check <token>` does this in the CLI; the web page
shows its own key as a QR ("Receive offline"), and when it scans a token with no network it
runs the same checks, shows "accepted offline, will redeem when online", and redeems the token
automatically (signing with its key) once the mint is reachable. Compact tokens and unlocked
tokens are refused offline, with the reason.

**Point of sale (NUT-18).** `crates/pos` (port of thesimplekid/cashu-payment-backend, see its
header for the fixes) serves `GET /create?amount=&unit=zat`, `GET /check/{id}` and
`POST /payment` on 127.0.0.1:8090, proxied as `https://<host>:5173/pos`. Its wallet needs
`zec-ecash-cli --wallet pos init` once; `devnet-up.sh` then starts it. The page's "Request
payment" card creates a request, shows its QR and polls until PAID; `zec-ecash-cli pay <creqA>`
pays one, locking the proofs to the POS key with a refund to the payer after 15 minutes
(`--refund-after`), so a refused payment can be taken back with `receive <token>` later. Start with `source scripts/env.sh` so the CLI uses the
same mint URL as the phone.

`--wallet <name>` (default `ecash`) uses `devnet/keys/<name>-wallet.seed` and
`devnet/<name>-wallet.redb`. The mint URL comes from `ZEC_MINT_URL` (or `--mint`), and the
CA for an HTTPS mint URL from `ZEC_MINT_CA` (or `--mint-ca`), both read from `.env` too.

### Web wallet on a phone
An HTTPS page can't call the plain-HTTP mint, and a phone can't reach 127.0.0.1, so the Vite
dev server serves the page over HTTPS on every interface and proxies `/mint/*` to the mint.
The mint URL every wallet uses, and every token carries, is `https://<host>:5173/mint`. Use a
stable hostname for `<host>`: this Mac's mDNS name doesn't change when the network or IP does.

1. One-time setup (needs Node >= 20 and `brew install mkcert`):

       (cd web && npm ci)
       scripts/set-mint-host.sh --init     # first time only: adopt mkcert's root as web/certs/rootCA.pem

2. Point everything at the hostname. Run this **before minting the ecash you'll demo**:

       scripts/set-mint-host.sh            # default: $(scutil --get LocalHostName).local

   It reissues the web server's leaf certificate (for the hostname, localhost, 127.0.0.1 and
   the current LAN IP), sets `ZEC_MINT_URL` in `.env`, sets `[info] url` in
   `mintd/config.toml` and applies it, then restarts the mint and the web server. It prints the
   old and new mint URLs. Ecash minted under the old URL counts as a different mint from then
   on; it is still redeemable with `zec-ecash-cli --mint <old url> ...`.
   If the network blocks mDNS (the phone can't open the `.local` name), use the IP instead:
   `scripts/set-mint-host.sh 192.168.1.22`. Then you must re-run it whenever the IP changes.
3. Trust the root CA on the phone, once. Send it `web/certs/rootCA.pem` (AirDrop or email;
   **only rootCA.pem, never rootCA-key.pem**, which stays in `mkcert -CAROOT`).
   - iPhone: open the file, Settings > General > VPN & Device Management > install the profile,
     then Settings > General > About > Certificate Trust Settings > turn on full trust for it.
   - Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.
   `set-mint-host.sh` only reissues the leaf certificate from that same root, and refuses to run
   if mkcert's root doesn't match `web/certs/rootCA.pem`. So the root installed on the phone stays
   valid across hostname and IP changes.
4. In each terminal you use for the CLI, run `source scripts/env.sh`.
5. On the phone, open `https://<LocalHostName>.local:5173`. The green dot means
   `/mint/v1/info` loaded; "Scan QR" asks for the camera (it only works over HTTPS).
   `scripts/devnet-up.sh status` checks that the web URL reaches the mint.

The CLI trusts the root through `ZEC_MINT_CA=web/certs/rootCA.pem` (CDK's HTTP client loads it
via `SSL_CERT_FILE`, plus the OS store), so `mkcert -install` on the Mac is optional.
`web/smoke.mjs` runs the page's cashu-ts calls from Node, for a check without a phone.

## Why the mint is a separate process
`cdk-sqlite` / `cdk-axum` and the Zcash crates conflict (`libsqlite3-sys`, `sha2`),
so they can't share one Cargo resolve. The wallet CLI uses `cdk-redb` for the same reason.

## Mainnet (experimental; real ZEC)

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
| mintd config | `mintd/config.toml` | `mintd/config.mainnet.toml` |
| keys | `scripts/devnet-reset.sh --new-keys` (runs `scripts/devnet-dkg.sh`) | distributed ceremony, one guardian per machine (`docs/deploy-mainnet.md`) |

- Chain access is only the light-wallet gRPC (GetLatestBlock, GetTransaction, GetBlock,
  SendTransaction, GetTreeState), so no local node is needed.
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
- The reserve cap (`ZEC_MAX_RESERVE`, default 1,000,000 zat) refuses deposit quotes that could
  push the reserve past it, counting open quotes; `GET /deposit-quote?amount=` says why.
- Devnet scripts pin `ZEC_NETWORK=regtest` and stop processes by their devnet ports, so they
  never stop a mainnet process; `devnet-reset.sh` never touches `mainnet/`.
- Seeds and keys are still never generated implicitly; seed files are created mode 600.

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

## Local devnet (regtest)
Zebra 6.4.2 serves the light-wallet gRPC protocol itself, so no lightwalletd or Zaino is needed.
Prerequisites: `cargo install zebrad --version 6.4.2 --locked`, `cargo install cdk-mintd --locked`,
and `CDK_MINTD_MNEMONIC="<24 words>"` in `.env` (the mint's only mnemonic source).

### Keys: `devnet/keys/` (gitignored, survives every reset)

| File | What |
|---|---|
| `guardian-{1,2,3}.key` | each guardian's FROST key share (secret; together they control the reserve) |
| `frost-pubkeys.json` | the guardians' public key package |
| `mint.ufvk` | the reserve's view-only key (Orchard `ak` = group key) |
| `user-wallet.seed` | devwallet user wallet (zebrad's `miner_address`) |
| `ecash-wallet.seed` | zec-ecash-cli wallet |

Nothing generates keys implicitly: zec-processor, the guardians and the CLI fail at startup if
theirs are missing. Everything else in `devnet/` is chain or mint state and may be deleted by a reset.

### Start, check, reset

    scripts/devnet-up.sh            # zebrad -> guardians 1-3 -> zec-processor -> cdk-mintd; waits for each
    ./devnet/mine.sh 110            # on a fresh chain: coinbase matures after 100 blocks
    scripts/devnet-up.sh status     # one line each; "guardians up: 1 2 down: 3 -> 2/3, can sign"
    scripts/guardians stop 3        # stop/start single guardians (start 3 to bring it back)
    scripts/devnet-reset.sh         # stop everything, delete chain + mint state, keep devnet/keys
    scripts/devnet-reset.sh --new-keys   # also new FROST keys, mint.ufvk and wallet seeds (asks first)

Shell environment: `source scripts/env.sh` exports `.env` (CDK_MINTD_MNEMONIC, ZEC_MINT_URL,
ZEC_MINT_CA with an absolute path) into your shell and fails loudly if the mint URL or CA is
missing. The CLI also reads `.env` from the repo root, but warns when `ZEC_MINT_URL` is unset.

Logs live in `devnet/logs/`. zec-processor, the guardians and the CLI rotate their own logs at
10 MB (5 old files kept). zebrad, cdk-mintd and the web server append to `devnet/logs/*.log`,
which `scripts/log-trim.sh` (started by `devnet-up.sh`, checked by `status`) cuts back to the
last 2 MB once a file passes 20 MB; it also keeps only 7 of cdk-mintd's daily files.

`devnet-reset.sh` deletes `devnet/zebra-state`, `devnet/mint` (cdk-mintd's work dir), every wallet
DB (`devnet/*.sqlite`, `devnet/*.redb`), the processor DB, `guardian-*.signed.json` (per-quote state
tied to the mint DB) and logs, and prints each path. Reserves and issued ecash only stay in step
if all of these go together, so don't delete them piecemeal. Without `--new-keys` all addresses
stay the same and `miner_address` stays valid. With it, reserves held by the old FROST key become
unspendable (devnet only), and it prints the new user address for `miner_address` in
`devnet/zebrad-regtest.toml`. Logs: `devnet/{zebrad,guardian-N,processor,mintd}.log`.

- Light-wallet gRPC: http://127.0.0.1:9067 (plaintext; point zec-processor here)
- JSON-RPC: http://127.0.0.1:18232 (`generate`, `getblockcount`)
- Wallet code must use `regtest::regtest_network()`; its heights must match the toml.
- Mine a block after each send (`./devnet/mine.sh`) so it confirms.

## Test wallet
`devwallet` is a regtest-only wallet (NOT for real funds) over the `zec-wallet` library crate,
which zec-processor will reuse for the mint's reserve wallet. Run it from the repo root.
Global flags go before the command:
`--seed <path>` (default `devnet/keys/user-wallet.seed`), `--db <path>` (default
`devnet/<seed name>.sqlite`), `--ufvk <path>` (a view-only wallet instead, in its own DB
`devnet/<name>-view.sqlite`) and `--lightwalletd <url>` (default `http://127.0.0.1:9067`).

    cargo run -p devwallet -- new                       # create the seed, print its address
    cargo run -p devwallet -- address                   # print the uregtest1... address
    cargo run -p devwallet -- sync                      # scan to the chain tip, print its height
    cargo run -p devwallet -- balance                   # sync, then spendable/pending per pool
    cargo run -p devwallet -- send <uregtest1...> <zats>   # sync, build, prove, sign, broadcast
    cargo run -p devwallet -- --seed devnet/keys/other.seed new     # a second, independent wallet
    cargo run -p devwallet -- --ufvk devnet/keys/mint.ufvk balance  # the mint reserve, view-only

- Put the user wallet's address in `devnet/zebrad-regtest.toml` `[mining] miner_address`.
- Coinbase needs 100 confirmations, shielded coinbase included (ZIP 213): the wallet locks each
  younger coinbase note, so it shows as pending and is never picked for a payment (the wallet
  library only checks this for transparent coinbase). On a fresh chain, `./devnet/mine.sh 110`.
- After `send`, run `./devnet/mine.sh 1`, then `balance`. Notes are spendable after 1
  confirmation (the regtest default); set `ZEC_MIN_CONFIRMATIONS` to use the processor's depth,
  e.g. `ZEC_MIN_CONFIRMATIONS=3 cargo run -p devwallet -- --ufvk devnet/keys/mint.ufvk
  --db devnet/mint-view.sqlite balance`. The zec-processor reserve wallet always uses
  `ZEC_MIN_CONFIRMATIONS`, for its balance and for the notes a withdrawal may spend. Change goes to Ironwood.
- Wallets start scanning at block 2 (Zebra rejects a tree-state request for block 0), so the
  user wallet doesn't see block 1's coinbase.
- Sapling proving parameters are compiled in (`zcash_proofs` `bundled-prover`), so nothing is
  downloaded; a send takes ~30 s in a debug build.
- The ecash CLI's seed is created once with `cargo run -p zec-ecash-cli -- init`
  (`scripts/devnet-reset.sh --new-keys` does it); its wallet DB is `devnet/ecash-wallet.redb`.
