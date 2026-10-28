# The local devnet (regtest) in detail

The quick version is in the [README](../README.md#run-it-locally-devnet). This page has the
rest: keys, resets, logs, the web wallet on a phone, and both demo wallets' commands.

Zebra 6.4.2 serves the light-wallet gRPC protocol itself, so no lightwalletd or Zaino is needed.
Prerequisites: Rust stable with `protoc` (`brew install protobuf` or
`apt-get install protobuf-compiler`), `cargo install zebrad --version 6.4.2 --locked`,
`cargo install cdk-mintd --version 0.18.2 --locked`, and `CDK_MINTD_MNEMONIC="<24 words>"` in
`.env` (the mint's only mnemonic source). For the web wallet: Node >= 20 and `mkcert`.

## Keys: `devnet/keys/` (gitignored, survives every reset)

| File | What |
|---|---|
| `guardian-{1,2,3}.key` | each guardian's FROST key share (secret; together they control the reserve) |
| `frost-pubkeys.json` | the guardians' public key package |
| `mint.ufvk` | the reserve's view-only key (Orchard `ak` = group key) |
| `user-wallet.seed` | devwallet user wallet (zebrad's `miner_address`) |
| `ecash-wallet.seed` | zec-ecash-cli wallet |

Nothing generates keys implicitly: zec-processor, the guardians and the CLI fail at startup if
theirs are missing. Everything else in `devnet/` is chain or mint state and may be deleted by a
reset.

## Start, check, reset

    scripts/devnet-up.sh            # zebrad -> guardians 1-3 -> zec-processor -> cdk-mintd (+ web, pos); waits for each
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

`devnet-reset.sh` deletes `devnet/zebra-state`, `devnet/mint` (cdk-mintd's work dir), every
wallet DB (`devnet/*.sqlite`, `devnet/*.redb`), the processor DB, `guardian-*.signed.json`
(per-quote state tied to the mint DB) and logs, and prints each path. Reserves and issued ecash
only stay in step if all of these go together, so don't delete them piecemeal. Without
`--new-keys` all addresses stay the same and `miner_address` stays valid. With it, reserves held
by the old FROST key become unspendable (devnet only), and it prints the new user address for
`miner_address` in `devnet/zebrad-regtest.toml`.

- Light-wallet gRPC: http://127.0.0.1:9067 (plaintext; point zec-processor here)
- JSON-RPC: http://127.0.0.1:18232 (`generate`, `getblockcount`)
- Wallet code must use `regtest::regtest_network()`; its heights must match the toml.
- Mine a block after each send (`./devnet/mine.sh`) so it confirms.
- The reserve cap (`ZEC_MAX_RESERVE`, default 1,000,000 zat) also applies on the devnet. A
  long-used devnet can reach it; `curl -s "127.0.0.1:8095/deposit-quote?amount=50000"` says so.
  Raise it for a session by restarting the processor:
  `kill $(lsof -tiTCP:50051 -sTCP:LISTEN); ZEC_MAX_RESERVE=5000000 scripts/devnet-up.sh`.
  For a few minutes after a processor restart the mint may still be reconnecting to it and miss
  a "paid" event; asking the mint for the quote
  (`curl -s 127.0.0.1:8085/v1/mint/quote/zec/<quote id>`) makes it check with the processor.

## Web wallet on a phone

An HTTPS page can't call the plain-HTTP mint, and a phone can't reach 127.0.0.1, so the Vite dev
server serves the page over HTTPS on every interface and proxies `/mint/*` to the mint. The mint
URL every wallet uses, and every token carries, is `https://<host>:5173/mint`. Use a stable
hostname for `<host>`: this Mac's mDNS name doesn't change when the network or IP does.

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
   `/mint/v1/info` loaded; Scan asks for the camera (it only works over HTTPS).
   `scripts/devnet-up.sh status` checks that the web URL reaches the mint.

The CLI trusts the root through `ZEC_MINT_CA=web/certs/rootCA.pem` (CDK's HTTP client loads it
via `SSL_CERT_FILE`, plus the OS store), so `mkcert -install` on the Mac is optional.
`web/smoke.mjs` runs the page's cashu-ts calls from Node, for a check without a phone.

## Ecash CLI (`zec-ecash-cli`)

A demo wallet on CDK's wallet crate. Don't use real funds.

    cargo run -p zec-ecash-cli -- init                     # once per wallet (seed in devnet/keys/)
    cargo run -p zec-ecash-cli -- --wallet bob init        # a second wallet, "bob"
    cargo run -p zec-ecash-cli -- deposit 50000            # quote, print address, wait for PAID, mint
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
    cargo run -p zec-ecash-cli -- withdraw <zat> <address>   # melt ecash to a ZEC address
    cargo run -p zec-ecash-cli -- reserves                # the reserve check's numbers

`--wallet <name>` (default `ecash`) uses `devnet/keys/<name>-wallet.seed` and
`devnet/<name>-wallet.redb`. The mint URL comes from `ZEC_MINT_URL` (or `--mint`), and the CA for
an HTTPS mint URL from `ZEC_MINT_CA` (or `--mint-ca`), both read from `.env` too. Start with
`source scripts/env.sh` so the CLI uses the same mint URL as the phone.

Wallets keep the minimal set of proofs (powers of two) for every mint, swap, send and receive, so
a token holds one proof per set bit of its amount. P2PK-locked sends (`--lock`) always include
DLEQ proofs, because the receiver needs them to accept the token offline.

The point-of-sale server's own wallet (`--wallet pos`, `pos sweep`) is legacy: only requests
created before payments were locked to the payee's phone kept money there, and on mainnet
nothing new lands in it.

## Test wallet (`devwallet`)

A regtest-only Zcash wallet (NOT for real funds) over the `zec-wallet` library crate, which
zec-processor reuses for the mint's reserve wallet. Run it from the repo root. Global flags go
before the command: `--seed <path>` (default `devnet/keys/user-wallet.seed`), `--db <path>`
(default `devnet/<seed name>.sqlite`), `--ufvk <path>` (a view-only wallet instead, in its own DB
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
  `ZEC_MIN_CONFIRMATIONS`, for its balance and for the notes a withdrawal may spend. Change goes
  to Ironwood.
- Wallets start scanning at block 2 (Zebra rejects a tree-state request for block 0), so the
  user wallet doesn't see block 1's coinbase.
- Sapling proving parameters are compiled in (`zcash_proofs` `bundled-prover`), so nothing is
  downloaded; a send takes ~30 s in a debug build.
