# Deploying zec-ecash on mainnet

**Real ZEC.** This is an experimental mint: run it with small amounts, behind the reserve cap,
and do the first deposit and withdrawal yourself before telling anyone about it.

This guide is written for this deployment:

| Machine | What | Runs | State |
|---|---|---|---|
| **main host** | Vultr, Ubuntu 24.04, user `gunit`, `zecmint.duckdns.org` | Caddy, cdk-mintd, zec-processor, **guardian 1** | repo `~/zec-ecash`; mint/processor state `~/zec-ecash/mainnet/`; guardian 1 state `~/mainnet/` |
| **guardian 2** | Vultr, Ubuntu 24.04, user `gunit`, no repo | **guardian 2** | binary `/usr/local/bin/guardian`; state `~/mainnet/` |
| **guardian 3** | your Mac | **guardian 3** | `~/mainnet/` (see section 9 for reaching it) |

Every guardian keeps its state in `~/mainnet/` (key share, `frost-pubkeys.json`, `mint.ufvk`, its
auth secret, its TLS certificate and key, `.env`) and runs `/usr/local/bin/guardian`, so one
systemd template (`deploy/systemd/zec-guardian@.service`) serves both Linux boxes. On the main
host, guardian 1's `~/mainnet/` is deliberately **not** the repo's `mainnet/`: the guardian never
sees the mint's mnemonic or the other guardians' auth secrets.

Any two key shares can spend the reserve, so no machine ever holds two. The main host holds one
(guardian 1) plus all three auth secrets: if it is compromised the attacker can ask guardians 2 and
3 to sign, but each guardian re-checks every withdrawal against the mint's public quote (checks
a-h) before it does.

All `guardian` commands run from your home directory (`cd ~`), so `mainnet/` means `~/mainnet/`.
All `zec-processor` commands run from `~/zec-ecash`. Every mainnet command needs
`ZEC_NETWORK=mainnet` (the systemd units set it themselves).

## 1. Base setup

### Both Vultr boxes

```sh
sudo apt update && sudo apt install -y ufw chrony curl netcat-openbsd openssl
sudo systemctl enable --now chrony     # clocks must agree within 60 s (guardian request auth)
```

### Main host

```sh
sudo apt install -y build-essential pkg-config git sqlite3
curl https://sh.rustup.rs -sSf | sh -s -- -y && . ~/.cargo/env
git clone https://github.com/guni7/zec-ecash.git ~/zec-ecash && cd ~/zec-ecash
git checkout <the reviewed commit>          # deploy-only checkout: never commit here (section 11)
cargo build --release -p zec-processor -p guardian -p zec-ecash-cli -p pos
cargo install cdk-mintd --version 0.18.2 --locked          # -> ~/.cargo/bin/cdk-mintd
sudo install -m 755 target/release/guardian /usr/local/bin/guardian    # guardian 1
mkdir -m 700 -p ~/zec-ecash/mainnet/keys ~/mainnet/keys
```

Caddy is already running with `deploy/Caddyfile.example` (domain `zecmint.duckdns.org`) and the
web wallet in `/srv/zec-ecash/web` (section 6).

### Guardian 2 (bare box)

Both boxes run Ubuntu 24.04, so the main host's build runs there unchanged. From the main host:

```sh
scp ~/zec-ecash/target/release/guardian ~/zec-ecash/deploy/systemd/zec-guardian@.service \
    ~/zec-ecash/deploy/guardian.env.example ~/zec-ecash/scripts/server-check.sh gunit@<GUARDIAN2_IP>:/tmp/
```

On guardian 2:

```sh
sudo install -m 755 /tmp/guardian /usr/local/bin/guardian
mkdir -m 700 -p ~/mainnet/keys
install -m 600 /tmp/guardian.env.example ~/mainnet/.env      # edit: section 5
install -m 755 /tmp/server-check.sh ~/server-check.sh
```

### Guardian 3 (Mac)

Build from a checkout (`cargo build --release -p guardian`), then
`sudo install -m 755 target/release/guardian /usr/local/bin/guardian` and
`mkdir -m 700 -p ~/mainnet/keys`.

## 2. Ports and firewall

Only 443 (and 80, for Caddy's certificate) is public. Everything else on the main host is
loopback. Guardian 2's port accepts the main host's IP only.

| Machine | Port | Who may connect |
|---|---|---|
| main host | 443/tcp, 80/tcp | everyone (Caddy) |
| main host | 9085 cdk-mintd, 51051 processor gRPC, 9095 status, 9090 point of sale, 8101 guardian 1 | loopback only |
| guardian 2 | 8102/tcp (TLS) | the main host's IP only |
| guardian 3 | 8103/tcp (TLS) | the main host only (section 9) |
| both Vultr boxes | 22/tcp | your admin IPs only |

Main host:

```sh
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow from <ADMIN_IP> to any port 22 proto tcp
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status verbose
```

Guardian 2 (its port from the main host's IP only):

```sh
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow from <ADMIN_IP> to any port 22 proto tcp
sudo ufw allow from <MAIN_HOST_IP> to any port 8102 proto tcp
sudo ufw enable && sudo ufw status verbose
```

Also add the same rules in Vultr's own firewall group if you use one (it filters before ufw).
Outbound: the main host reaches the light-wallet server (443) and the guardians; each guardian
reaches `https://zecmint.duckdns.org/mint` (443) for its quote checks.

## 3. DKG ceremony (three machines)

Produces the reserve's spend key as three shares, without the key ever existing in one place.
`guardian dkg` advances one step each time it is run, as far as the files in its inbox allow.
Move files with `scp` (directly, or through your laptop over SSH); never email or chat them.

| File | Secret? | Goes to |
|---|---|---|
| `~/mainnet/dkg/outbox/round1-from-N.json` | no | both other guardians |
| `~/mainnet/dkg/outbox/round2-from-N-to-M.json` | **yes: guardian M's share** | guardian M only, then delete every copy |
| `~/mainnet/keys/frost-pubkeys.json` | no | the main host's `~/zec-ecash/mainnet/keys/` |
| `~/zec-ecash/mainnet/keys/mint.ufvk` | no (view key) | every guardian's `~/mainnet/keys/` |
| `~/mainnet/dkg/outbox/verify-N.json` | no | both other guardians |

1. **Round 1**, on each guardian N (1 on the main host, 2, 3):
   ```sh
   cd ~ && ZEC_NETWORK=mainnet guardian --id N dkg --threshold 2 --participants 3
   ```
2. Copy each `~/mainnet/dkg/outbox/round1-from-N.json` into the other two guardians'
   `~/mainnet/dkg/inbox/`.
3. **Round 2**, on each guardian: run the same command again. It writes `round2-from-N-to-M.json`
   for each other guardian M (mode 600).
4. Copy each `round2-from-N-to-M.json` **only** to guardian M's `~/mainnet/dkg/inbox/`, then
   delete every other copy, e.g. from the main host (guardian 1) to guardian 2:
   ```sh
   scp ~/mainnet/dkg/outbox/round2-from-1-to-2.json gunit@<GUARDIAN2_IP>:mainnet/dkg/inbox/ && \
     shred -u ~/mainnet/dkg/outbox/round2-from-1-to-2.json
   ```
   Six files: 1->2, 1->3, 2->1, 2->3, 3->1, 3->2. A guardian refuses to continue if its inbox
   holds a round-2 file addressed to someone else.
5. **Key shares**, on each guardian: run the command once more. It writes
   `~/mainnet/keys/guardian-N.key` (mode 600) and `~/mainnet/keys/frost-pubkeys.json`, and prints
   the group key. The three printed group keys must be identical.
6. On the main host, give the processor the public key package and make the view key (once):
   ```sh
   cp ~/mainnet/keys/frost-pubkeys.json ~/zec-ecash/mainnet/keys/
   cd ~/zec-ecash && ZEC_NETWORK=mainnet ./target/release/zec-processor make-ufvk
   cp ~/zec-ecash/mainnet/keys/mint.ufvk ~/mainnet/keys/                  # guardian 1
   scp ~/zec-ecash/mainnet/keys/mint.ufvk gunit@<GUARDIAN2_IP>:mainnet/keys/   # guardian 2
   ```
   and copy `mint.ufvk` to guardian 3's `~/mainnet/keys/` too.
7. **Verify**, on each guardian: `cd ~ && ZEC_NETWORK=mainnet guardian --id N verify`. Copy each
   `~/mainnet/dkg/outbox/verify-N.json` into the other guardians' `~/mainnet/dkg/inbox/`, then run
   `verify` again on each. Each must print `all 3 guardians agree on the group key and the UFVK`.
   Also compare the printed group key and mint address between machines by eye.
8. **Back up** each `guardian-N.key` separately (encrypted, offline, different places). Losing two
   loses the reserve; leaking two loses it too.

## 4. Guardian transport (TLS + request authentication)

On the main host, a private CA for the guardians' certificates. The second argument after the
guardian id must be exactly the host in that guardian's `ZEC_GUARDIANS` URL:

```sh
cd ~/zec-ecash
scripts/guardian-ca.sh init mainnet/ca
scripts/guardian-ca.sh issue mainnet/ca 1 127.0.0.1            # guardian 1 is local
scripts/guardian-ca.sh issue mainnet/ca 2 <GUARDIAN2_IP>
scripts/guardian-ca.sh issue mainnet/ca 3 <GUARDIAN3_ADDRESS>  # see section 9
cp mainnet/ca/guardian-ca.crt mainnet/keys/
cp mainnet/ca/guardian-1-tls.crt mainnet/ca/guardian-1-tls.key ~/mainnet/keys/
scp mainnet/ca/guardian-2-tls.crt mainnet/ca/guardian-2-tls.key gunit@<GUARDIAN2_IP>:mainnet/keys/
```

(and guardian 3's pair to the Mac). Then move `mainnet/ca/guardian-ca.key` off the server to an
offline backup; it is needed only to issue certificates again.

On each guardian, its request-auth secret; the main host (only) gets a copy:

```sh
cd ~ && ZEC_NETWORK=mainnet guardian --id N make-auth-key      # ~/mainnet/keys/guardian-N.auth
```

```sh
# on the main host
cp ~/mainnet/keys/guardian-1.auth ~/zec-ecash/mainnet/keys/
scp gunit@<GUARDIAN2_IP>:mainnet/keys/guardian-2.auth ~/zec-ecash/mainnet/keys/
chmod 600 ~/zec-ecash/mainnet/keys/guardian-*.auth
```

(and `guardian-3.auth` from the Mac). Every `/round1` and `/round2` request then carries an
HMAC-SHA256 over method, path, timestamp and body; a guardian refuses one without a valid HMAC,
more than 60 s off, or seen before, before it makes any nonce. A mainnet guardian won't start
without its TLS files and auth secret; the processor won't start without `https://` guardian URLs
and all three secrets.

## 5. Configuration

**Main host**, `~/zec-ecash/mainnet/.env` from `deploy/mainnet.env.example` (every variable is
explained there):

```sh
cd ~/zec-ecash && install -m 600 deploy/mainnet.env.example mainnet/.env && nano mainnet/.env
```

Set at least `ZEC_MINT_URL=https://zecmint.duckdns.org/mint`, `CDK_MINTD_MNEMONIC` (24 BIP-39 words
generated offline for this mint only, quoted), and
`ZEC_GUARDIANS=https://127.0.0.1:8101,https://<GUARDIAN2_IP>:8102,https://<GUARDIAN3_ADDRESS>:8103`.
In `mintd/config.mainnet.toml` set `[info] url = "https://zecmint.duckdns.org/mint/"`.

**Each guardian**, `~/mainnet/.env` from `deploy/guardian.env.example`:

| | `ZEC_MINT_URL` | `ZEC_GUARDIAN_LISTEN` |
|---|---|---|
| guardian 1 (main host) | `https://zecmint.duckdns.org/mint` | `127.0.0.1:8101` |
| guardian 2 | `https://zecmint.duckdns.org/mint` | `0.0.0.0:8102` |
| guardian 3 (Mac) | `https://zecmint.duckdns.org/mint` | see section 9 |

On the main host: `install -m 600 ~/zec-ecash/deploy/guardian.env.example ~/mainnet/.env`.

## 6. Web wallet

On the main host (or any machine with Node 20 and the main host's `mainnet/.env`):

```sh
cd ~/zec-ecash/web && npm ci
ZEC_NETWORK=mainnet ZEC_ENV_FILE=../mainnet/.env npx vite build --outDir dist-mainnet
sudo rsync -a --delete dist-mainnet/ /srv/zec-ecash/web/
```

The page is compiled for mainnet: MAINNET badge and banner, and it disables itself unless it is
opened at exactly `https://zecmint.duckdns.org` (tokens carry the mint URL).

## 7. Install and start the services (systemd)

The units refuse to start until their key and config files exist (`ConditionPathExists`), so
installing them before the DKG is safe: they stay inactive until everything is in place. They run
as `gunit`, restart on any exit (`Restart=always`, every 5 s), and log through the devlog caps
(`processor.log`, `guardian-N.log`: 10 MB x 6 files each).

### Main host

Initialise the mint's work dir once (it reads the mnemonic from `mainnet/.env`):

```sh
cd ~/zec-ecash && mkdir -p mainnet/mint
( set -a; . mainnet/.env; set +a; ~/.cargo/bin/cdk-mintd -w mainnet/mint config init --new-mint --file mintd/config.mainnet.toml )
```

Then install all three units and start them (guardian 1, the processor, then the mint):

```sh
sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now zec-guardian@1
sudo systemctl enable --now zec-processor
sudo systemctl enable --now zec-mintd
```

cdk-mintd also writes daily files to `mainnet/mint/logs/`; bound them (and anything else in
`mainnet/logs/`) with a cron job (`crontab -e`):

```
*/10 * * * * cd /home/gunit/zec-ecash && LOG_STATE=mainnet scripts/log-trim.sh >/dev/null 2>&1
```

### Guardian 2

```sh
sudo cp /tmp/zec-guardian@.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now zec-guardian@2
```

### Guardian 3 (Mac)

No systemd on macOS: run it in a terminal (or a launchd agent) from your home directory:

```sh
cd ~ && ZEC_NETWORK=mainnet guardian --id 3 --listen 127.0.0.1:8103 serve
```

### Checking

```sh
systemctl status zec-processor zec-mintd zec-guardian@1     # main host
journalctl -u zec-processor -f                              # startup and errors
tail -f ~/zec-ecash/mainnet/logs/processor.log ~/mainnet/logs/guardian-1.log
~/zec-ecash/scripts/server-check.sh                         # main host
~/server-check.sh                                           # guardian 2
```

`scripts/server-check.sh` prints the units' status and restart counts, guardian certificate expiry
and free disk on every box; on the main host also the public certificate's expiry, `/reserves`,
and whether each guardian answers over TLS with the same group key. It exits 1 when something
needs attention, so it can run from cron and mail you.

A unit that stays `inactive` with `ConditionResult=no` is waiting for a file
(`systemctl show -p ConditionResult zec-guardian@2`; the unit file lists which).

`scripts/mainnet-up.sh` still works as an alternative to systemd on a host with the repo (roles in
`ZEC_ROLES`, guardian state in the repo's `mainnet/`); don't run both.

### Point of sale (main host, optional)

The web wallet's Receive › Request an amount creates NUT-18 payment requests at the point of sale
(`crates/pos`, `zec-pos.service`): Caddy proxies `https://zecmint.duckdns.org/pos/*` to it on
127.0.0.1:9090. Without it the page greys out Request an amount ("Payment requests are unavailable right now")
and points to Receive without internet (the payer sends a locked code back, which works offline).

**The server never holds spendable money.** Each request is P2PK-locked to a fresh key that only
the payee's phone holds (derived from its wallet seed, one key per request). Payers lock their
ecash to that key. On delivery the server checks the payment without claiming it: the mint
(`ZEC_MINT_URL` only), the unit (zat), that every proof is locked to exactly that key with no
locktime, refund keys or extra pubkeys, valid DLEQ proofs, unspent at the mint (NUT-07), and no
proof accepted twice. A payment failing any of these is refused. One that passes is never
refused, because its ecash is locked to the payee's key and refusing it would strand it: a full
payment marks the request PAID (of two racing payers exactly one wins); one that loses the race
or arrives after PAID is stored as an extra payment; one short of the request (on time or late)
as a partial payment, leaving the request unpaid. The phone collects all of them and can refund
extras and partials. The phone collects it with requests signed by the request's
key, redeems it at the mint, and acknowledges; the server then deletes its copy (only once the
mint reports those proofs spent). So the server learns amounts and timing, and a compromised
server can withhold or delete payments, but it can't spend them. On MAINNET it refuses requests
without the payee's key.

Its settings (`ZEC_POS_URL`, `ZEC_POS_ADDR`) are in `mainnet/.env` (see
`deploy/mainnet.env.example`). It still needs a wallet seed to start (it uses the wallet as its
mint client for keysets and NUT-07 checks, and for the legacy wallet below):

```sh
cd ~/zec-ecash
ZEC_NETWORK=mainnet ./target/release/zec-ecash-cli --wallet pos init   # once: mainnet/keys/pos-wallet.seed, mode 600
sudo systemctl enable --now zec-pos
```

Check:

```sh
systemctl status zec-pos && tail -f ~/zec-ecash/mainnet/logs/pos.log
curl -s http://127.0.0.1:9090/health; curl -s https://zecmint.duckdns.org/pos/health
sqlite3 ~/zec-ecash/mainnet/pos/pos.sqlite "SELECT COUNT(*) FROM pos_quote WHERE token IS NOT NULL"   # paid, not yet collected
```

State is in `mainnet/pos/` (request DB with the stored, payee-locked payments; the legacy wallet;
the admin socket). Back it up like the rest of `mainnet/`: a payment stays there until the
payee's phone collects it.

**Legacy: the POS wallet and `pos sweep`.** Requests created before locked payments were locked
to the POS's own key and redeemed into its wallet. On MAINNET nothing new lands there (legacy
requests can't be created or paid any more), but move any balance it still has out:

```sh
ZEC_NETWORK=mainnet ./target/release/pos balance        # what the legacy wallet holds
ZEC_NETWORK=mainnet ./target/release/pos sweep          # a token for all of it (or: pos sweep <zat>)
ZEC_NETWORK=mainnet ./target/release/zec-ecash-cli receive <token>       # into your own wallet
ZEC_NETWORK=mainnet ./target/release/zec-ecash-cli withdraw <zat> <u1...>   # and out to ZEC, if you like
```

`pos sweep` asks the running service over `mainnet/pos/admin.sock` (mode 600, only `gunit`), so
it keeps serving; each token is also saved in `mainnet/pos/sweeps/` (mode 600) before it is
printed: delete the file once the token is redeemed. To withdraw straight from the legacy wallet
instead, stop the service first (its wallet DB is locked while it runs):
`sudo systemctl stop zec-pos && ZEC_NETWORK=mainnet ./target/release/zec-ecash-cli --wallet pos withdraw <zat> <u1...> && sudo systemctl start zec-pos`.

`server-check.sh` checks the unit, `/health` locally and through Caddy, and prints what the legacy
wallet holds.

## 8. Before the first transaction

- `server-check.sh` reports "all good" on the main host and guardian 2.
- `journalctl -u zec-processor` / `processor.log` shows `guardian up` for all three with the same
  group key, and the reserve wallet's birthday near the current tip.
- `curl https://zecmint.duckdns.org/reserves`: `"state":"ok"`.
- Each guardian's `verify` reported that all three agree; key shares backed up.
- From another machine: guardian 2's 8102 is closed (only the main host gets in), and the main
  host's 9085, 9095, 9090, 51051 and 8101 are closed.
- `curl https://zecmint.duckdns.org/pos/health`: `{"ok":true,...}` (if you run the point of sale).
- Then one small deposit (10,000 zat or more) and one small withdrawal, watched end to end.

## 9. Guardian 3 on a Mac

The processor must reach guardian 3 over TLS, but a Mac at home is usually behind NAT and moves
between networks. Two workable setups:

- **SSH reverse tunnel** (simplest): the Mac keeps a tunnel open to the main host, so guardian 3
  appears on the main host's loopback. Issue guardian 3's certificate for `127.0.0.1`, set
  `ZEC_GUARDIANS=...,https://127.0.0.1:8103`, run guardian 3 with `--listen 127.0.0.1:8103`, and:
  ```sh
  ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 127.0.0.1:8103:127.0.0.1:8103 gunit@<MAIN_HOST_IP>
  ```
  (`autossh` keeps it up.) Nothing on the Mac is exposed to the internet.
- **A private network** (WireGuard or Tailscale) between the Mac and the main host: issue the
  certificate for the Mac's private address and listen on it.

Guardian 3 is offline whenever the Mac sleeps; withdrawals still need only two guardians (1 and
2), so that is fine, but while guardian 2 is down too, withdrawals stop until one comes back.

## 10. Running it

- `/reserves` (HTTP 200 ok, 503 otherwise) is the thing to monitor; `server-check.sh` and
  `zec-ecash-cli reserves` print it. `RESERVE INVARIANT VIOLATED` and `CRITICAL` lines in
  `processor.log` need a person.
- A withdrawal flagged `operator_action_required` (reported PAID, then reorged out and expired):
  pay the recipient by other means, then
  `cd ~/zec-ecash && ZEC_NETWORK=mainnet ./target/release/zec-processor resolve <quote_id>`.
  `/reserves` is public, so it lists only the quote id, amount and time flagged; the address,
  txid and reason are in `processor.log` (the CRITICAL line) and in
  `ZEC_NETWORK=mainnet ./target/release/zec-processor operator-actions`.
- Updating: rebuild on the main host, `sudo install` the new guardian binary on each guardian box,
  `sudo systemctl restart zec-guardian@N zec-processor zec-mintd zec-pos`.
- Rotating a guardian's auth secret: `make-auth-key` refuses to overwrite, so move the old
  `guardian-N.auth` aside on both machines, make a new one, copy it, restart both.
- Rotating TLS: `scripts/guardian-ca.sh issue` again with the CA key, copy, restart the guardian.
- Point of sale: payments go to the payee's phone; the legacy POS wallet's balance, if any, out with `ZEC_NETWORK=mainnet ./target/release/pos sweep` (section 7).

## 11. Never commit

`.gitignore` covers all of these; never force-add one (`git add -f`):

- **Secrets:** every `.env` anywhere (`.env`, `mainnet/.env`, `*.env`; only the commented
  `*.env.example` templates are tracked), `devnet/keys/`, `*.key`, `*.auth`, `*.seed`, `*.gpg`,
  `*-key.pem` (incl. `rootCA-key.pem`), `guardian-ca.key`, `web/certs/`, every `dkg/`
  directory (round-1/round-2/verify files and DKG state), and `*.token` (point-of-sale sweeps:
  spendable ecash) with the POS state in `devnet/pos/`.
- **The whole `mainnet/` directory:** keys, `ca/`, `mint/`, databases, logs, `dkg/`, `judge-kit/`.
- **State and logs:** `*.sqlite`, `*.sqlite-*`, `*.db`, `*.redb`, the devnet chain and mint work
  dirs under `devnet/`, `*.log`, `*.log.*`, `logs/`.
- **Build output:** `target/`, `node_modules/`, `web/dist/`, `web/dist-mainnet/`.
- **OS/editor:** `.DS_Store`, `*.swp`, `.idea/`, `.vscode/`.

**The server checkout is deploy-only.** On the main host, `~/zec-ecash` only ever does
`git fetch` and `git checkout <reviewed commit>`: never `git add`, `git commit` or `git push`
there. Make changes on your own machine, review them, push, then check the commit out on the
server.
