# zec-ecash

A Cashu ecash mint for ZEC: stock `cdk-mintd` plus our `zec-processor` over CDK's gRPC
payment-processor API. Reserves sit in the Ironwood shielded pool; withdrawals are
signed 2-of-3 with FROST (RedPallas).

## Prerequisites
- Rust stable (`rustup`), and `protoc`: `apt-get install protobuf-compiler` or `brew install protobuf`

## Build and test
    cargo build
    cargo test --workspace
    cargo clippy --workspace && cargo fmt --all

## Run the mint (separate process; it can't live in this workspace)
Phase 1 is ZEC deposits: a mint quote gets a fresh address of the mint's reserve wallet,
zec-processor watches for the payment, and the mint issues ecash. Phase 2 is withdrawals: a
melt sends ZEC from the Ironwood reserves to a shielded address, signed with the single mint
key (2-of-3 FROST comes in Phase 4).
With the regtest devnet running (see "Local devnet" below):

    cargo install cdk-mintd --locked
    cargo run -p devwallet -- --seed devnet/mint-wallet.seed new   # once: mint reserve wallet
    cargo run -p zec-processor &          # gRPC on 127.0.0.1:50051, syncs every 7 s

    # once: a devnet mint mnemonic in devnet/mintd.env (CDK_MINTD_MNEMONIC="<24 words>"),
    # then store the config in the mint's database
    set -a; . devnet/mintd.env; set +a
    cdk-mintd -w devnet/mint config init --new-mint --file mintd/config.toml
    cdk-mintd -w devnet/mint --enable-logging           # HTTP on 127.0.0.1:8085

    curl -s 127.0.0.1:8085/v1/info                      # nut04 lists method "zec", unit "zat"
    cargo run -p zec-ecash-cli -- deposit 50000         # prints an address, waits, mints
    cargo run -p devwallet -- send <that address> 50000 && ./devnet/mine.sh 1

    cargo run -p zec-ecash-cli -- withdraw 20000 $(cargo run -q -p devwallet -- address)
    ./devnet/mine.sh 1                                   # the CLI prints PAID and the txid

After changing `mintd/config.toml`, run `cdk-mintd -w devnet/mint config apply --file mintd/config.toml`.
Use only `devnet/mint` as the mint's work dir: a second mint database on the same URL has
different keysets, and wallets that used one fail against the other ("Unknown Keyset").

zec-processor settings (environment, or `.env` in the repo root; defaults shown):

    ZEC_LIGHTWALLETD=http://127.0.0.1:9067
    ZEC_MINT_SEED=devnet/mint-wallet.seed     # wallet DB: devnet/mint-wallet.sqlite
    ZEC_PROCESSOR_DB=devnet/processor.sqlite  # quote table zec_deposit_address
    ZEC_GRPC_ADDR=127.0.0.1:50051
    ZEC_CONFIRMATIONS=1
    ZEC_MIN_ZATS=1000                         # keep equal to min_mint/max_mint in mintd/config.toml
    ZEC_MAX_ZATS=100000000000
    ZEC_SYNC_INTERVAL_SECS=7

- The processor speaks plaintext gRPC, so mintd needs `allow_insecure = true`; keep both on loopback.
- Withdrawals pay only unified addresses with an Orchard receiver (they land in Ironwood);
  transparent and Sapling-only addresses are rejected at quote time.
- A withdrawal reports Pending from the moment its transaction is built until it is mined, and
  Failed only if it was never broadcast or expired unmined, because the mint refunds the ecash
  on Failed. State lives in `zec_withdrawal` in `devnet/processor.sqlite`; after a crash the
  processor fails unbroadcast withdrawals and rebroadcasts broadcast ones.
- zec-processor builds the Orchard proving key at startup (about 30 s in a debug build).

## Why the mint is a separate process
`cdk-sqlite` / `cdk-axum` and the Zcash crates conflict (`libsqlite3-sys`, `sha2`),
so they can't share one Cargo resolve. The wallet CLI uses `cdk-redb` for the same reason.

## Version notes
- `orchard` is pinned to `=0.15.5`; 0.16 conflicts with `zcash_primitives` 0.30.
- Enabling `pczt` on `zcash_client_backend` turns on transparent inputs, so
  `zcash_client_sqlite` needs `transparent-inputs` too.
- Ironwood support is behind the `orchard` feature; there is no `ironwood` feature.

## Local devnet (regtest)
Zebra 6.4.2 serves the light-wallet gRPC protocol itself, so no lightwalletd or Zaino is needed.

    cargo install zebrad --version 6.4.2 --locked
    # put your test wallet's uregtest1... address in devnet/zebrad-regtest.toml [mining]
    zebrad -c devnet/zebrad-regtest.toml start
    ./devnet/mine.sh 110                  # coinbase matures after 100 blocks

- Light-wallet gRPC: http://127.0.0.1:9067 (plaintext; point zec-processor here)
- JSON-RPC: http://127.0.0.1:18232 (`generate`, `getblockcount`)
- Wallet code must use `regtest::regtest_network()`; its heights must match the toml.
- Mine a block after each send (`./devnet/mine.sh`) so it confirms.
- Reset the chain: stop zebrad, delete devnet/zebra-state.

## Test wallet
`devwallet` is a regtest-only wallet (NOT for real funds) over the `zec-wallet` library crate,
which zec-processor will reuse for the mint's reserve wallet. Run it from the repo root.
Global flags go before the command:
`--seed <path>` (default `devnet/user-wallet.seed`; the wallet DB is the same path with
`.sqlite`) and `--lightwalletd <url>` (default `http://127.0.0.1:9067`).

    cargo run -p devwallet -- new                       # create the seed, print its address
    cargo run -p devwallet -- address                   # print the uregtest1... address
    cargo run -p devwallet -- sync                      # scan to the chain tip, print its height
    cargo run -p devwallet -- balance                   # sync, then spendable/pending per pool
    cargo run -p devwallet -- send <uregtest1...> <zats>   # sync, build, prove, sign, broadcast
    cargo run -p devwallet -- --seed devnet/mint-wallet.seed new   # the mint's reserve wallet

- Put the user wallet's address in `devnet/zebrad-regtest.toml` `[mining] miner_address`.
- Coinbase needs 100 confirmations: if funds show only as pending, `./devnet/mine.sh 110`.
- After `send`, run `./devnet/mine.sh 1`, then `balance`. Notes are spendable after 1
  confirmation (a regtest setting; ZIP 315's default is 3 or 10). Change goes to Ironwood.
- Wallets start scanning at block 2 (Zebra rejects a tree-state request for block 0), so the
  user wallet doesn't see block 1's coinbase.
- Sapling proving parameters are compiled in (`zcash_proofs` `bundled-prover`), so nothing is
  downloaded; a send takes ~30 s in a debug build.
- Reset a wallet's view of the chain: delete its `.sqlite` file (the seed stays). After a
  chain reset, delete all `devnet/*.sqlite`.
