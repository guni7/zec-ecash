# Deploying zec-ecash on mainnet

**Real ZEC.** This is an experimental mint: run it with small amounts, behind the reserve cap,
and do the first deposit and withdrawal yourself before telling anyone about it.

Commands below run from the repository root on each machine, as the unprivileged user that owns
the checkout. `G` is `./target/release/guardian`, `P` is `./target/release/zec-processor`.
Every mainnet command needs `ZEC_NETWORK=mainnet` (scripts/mainnet-up.sh sets it itself).

## 1. Machines and what runs where

| Machine | Runs | Holds |
|---|---|---|
| **mint host** (public) | Caddy, cdk-mintd, zec-processor (`ZEC_ROLES=processor,mint`) | `mint.ufvk` (view key: sees, can't spend), `frost-pubkeys.json`, the three `guardian-N.auth` secrets, `guardian-ca.crt`, the mint's ecash mnemonic |
| **guardian 1, 2, 3** (one VPS each, different providers if you can) | `guardian` (`ZEC_ROLES=guardian:N`) | its own `guardian-N.key` (spend share), its TLS key, its auth secret, `mint.ufvk`, `frost-pubkeys.json` |

Any two guardian key shares can spend the reserve, so no machine ever holds two of them, and the
mint host holds none. A compromised mint host can ask the guardians to sign, but each guardian
re-checks every withdrawal against the mint's public quote (checks a-h) before signing.

## 2. Base setup (every machine)

Debian 12 or Ubuntu 24.04, 2 vCPU / 4 GB RAM (the Orchard proving key needs ~1 GB), 20 GB disk.

```sh
sudo apt update && sudo apt install -y build-essential pkg-config git curl ufw chrony sqlite3 netcat-openbsd
sudo systemctl enable --now chrony          # clocks must agree within 60 s (request auth window)
sudo adduser --disabled-password zec && sudo -iu zec
curl https://sh.rustup.rs -sSf | sh -s -- -y && . ~/.cargo/env
git clone https://github.com/guni7/zec-ecash.git && cd zec-ecash
git checkout <the reviewed commit>          # the same commit on every machine
cargo build --release -p guardian -p zec-processor
```

Mint host only:

```sh
cargo install cdk-mintd --version 0.18.2 --locked
sudo apt install -y caddy                    # https://caddyserver.com/docs/install#debian-ubuntu-raspbian
```

The web wallet is built on any machine with Node 20 (section 7).

## 3. Ports and firewall

Only 443 (and 80, for Caddy's certificate) is public. Everything else is loopback, except each
guardian's port, which only the mint host's IP may reach.

| Machine | Port | Who may connect |
|---|---|---|
| mint host | 443/tcp, 80/tcp | everyone (Caddy) |
| mint host | 9085 cdk-mintd, 51051 processor gRPC, 9095 status, 9090 POS | loopback only (Caddy proxies 9085, 9095, 9090) |
| guardian N | 810N/tcp (TLS) | the mint host's IP only |
| all | 22/tcp | your admin IPs only |

Outbound: the mint host reaches the light-wallet server (`ZEC_LWD_URL`, 443) and the guardians
(810N); each guardian reaches the mint's public URL (443) for its quote checks.

```sh
# every machine
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow from <ADMIN_IP> to any port 22 proto tcp
# mint host
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# guardian N (N = 1, 2, 3)
sudo ufw allow from <MINT_HOST_IP> to any port 810N proto tcp
sudo ufw enable && sudo ufw status verbose
```

## 4. DKG ceremony (three machines)

Produces the reserve's spend key as three shares, without the key ever existing in one place.
`guardian dkg` advances one step each time it is run, as far as the files in its inbox allow.
Use `scp` between machines (or via your laptop over SSH); never email or chat these files.

| File | Secret? | Goes to |
|---|---|---|
| `mainnet/dkg/outbox/round1-from-N.json` | no | both other guardians |
| `mainnet/dkg/outbox/round2-from-N-to-M.json` | **yes: guardian M's share** | guardian M only, then delete every copy |
| `mainnet/keys/frost-pubkeys.json` | no | the mint host |
| `mainnet/keys/mint.ufvk` | no (view key) | every guardian |
| `mainnet/dkg/outbox/verify-N.json` | no | both other guardians |

1. **Round 1**, on each guardian N:
   ```sh
   ZEC_NETWORK=mainnet G --id N dkg --threshold 2 --participants 3
   ```
2. Copy `mainnet/dkg/outbox/round1-from-N.json` from each guardian into the other two guardians'
   `mainnet/dkg/inbox/`, e.g. from your laptop:
   ```sh
   scp g1:zec-ecash/mainnet/dkg/outbox/round1-from-1.json /tmp/ && \
     scp /tmp/round1-from-1.json g2:zec-ecash/mainnet/dkg/inbox/ && \
     scp /tmp/round1-from-1.json g3:zec-ecash/mainnet/dkg/inbox/
   ```
   (and the same for 2 and 3).
3. **Round 2**, on each guardian: run the same `dkg` command again. It writes
   `round2-from-N-to-M.json` for each other guardian M (mode 600).
4. Copy each `round2-from-N-to-M.json` **only** to guardian M's `mainnet/dkg/inbox/`, then delete
   the copy on your laptop and the original in guardian N's outbox:
   ```sh
   scp g1:zec-ecash/mainnet/dkg/outbox/round2-from-1-to-2.json /tmp/ && \
     scp /tmp/round2-from-1-to-2.json g2:zec-ecash/mainnet/dkg/inbox/ && \
     shred -u /tmp/round2-from-1-to-2.json && \
     ssh g1 shred -u zec-ecash/mainnet/dkg/outbox/round2-from-1-to-2.json
   ```
   Six files in total: 1->2, 1->3, 2->1, 2->3, 3->1, 3->2. A guardian refuses to continue if its
   inbox holds a round-2 file addressed to someone else.
5. **Key shares**, on each guardian: run `dkg` once more. It writes `mainnet/keys/guardian-N.key`
   (mode 600) and `mainnet/keys/frost-pubkeys.json`, and prints the group key. The three printed
   group keys must be identical.
6. Copy `mainnet/keys/frost-pubkeys.json` from guardian 1 to the mint host's `mainnet/keys/`, and
   make the view key there (once):
   ```sh
   ZEC_NETWORK=mainnet P make-ufvk          # writes mainnet/keys/mint.ufvk
   ```
7. Copy the mint host's `mainnet/keys/mint.ufvk` to every guardian's `mainnet/keys/`.
8. **Verify**, on each guardian:
   ```sh
   ZEC_NETWORK=mainnet G --id N verify
   ```
   Copy each `mainnet/dkg/outbox/verify-N.json` into the other guardians' `mainnet/dkg/inbox/`,
   then run `verify` again on each. Each must print
   `all 3 guardians agree on the group key and the UFVK`. Also read the printed group key and mint
   address aloud between the operators (out of band): all three must match.
9. **Back up** each `guardian-N.key` separately (encrypted, offline, different places). Losing
   two of them loses the reserve; leaking two of them loses it too.

## 5. Guardian transport (TLS + request authentication)

On the mint host, a private CA for the guardians' certificates. `<host-or-ip>` must be exactly
what `ZEC_GUARDIANS` will use for that guardian:

```sh
scripts/guardian-ca.sh init mainnet/ca
scripts/guardian-ca.sh issue mainnet/ca 1 g1.example.net      # or an IP address
scripts/guardian-ca.sh issue mainnet/ca 2 g2.example.net
scripts/guardian-ca.sh issue mainnet/ca 3 g3.example.net
cp mainnet/ca/guardian-ca.crt mainnet/keys/
```

Copy `guardian-N-tls.crt` and `guardian-N-tls.key` to guardian N's `mainnet/keys/`, then move
`mainnet/ca/guardian-ca.key` off the server (offline backup); it is needed only to issue
certificates again.

On each guardian, its request-auth secret, and give the mint host (only) a copy:

```sh
ZEC_NETWORK=mainnet G --id N make-auth-key     # mainnet/keys/guardian-N.auth (mode 600)
scp gN:zec-ecash/mainnet/keys/guardian-N.auth mint:zec-ecash/mainnet/keys/
```

Every `/round1` and `/round2` request then carries an HMAC-SHA256 over method, path, timestamp and
body. A guardian refuses requests without a valid one, with a timestamp more than 60 s off, or
seen before, before it generates any nonce. A mainnet guardian won't start without its TLS files
and auth secret; a mainnet processor won't start without https:// guardian URLs and all three
secrets.

## 6. Configuration

`mainnet/.env` on the **mint host** (mode 600; never the devnet's `.env`):

```sh
ZEC_ROLES=processor,mint
ZEC_MINT_URL=https://mint.example.com/mint
ZEC_GUARDIANS=https://g1.example.net:8101,https://g2.example.net:8102,https://g3.example.net:8103
ZEC_LWD_URL=https://zec.rocks:443           # or your own lightwalletd / Zebra (recommended)
ZEC_MIN_ZATS=10000                          # = min_mint / min_melt in mintd/config.mainnet.toml
ZEC_MAX_ZATS=1000000                        # = max_mint / max_melt
ZEC_MAX_RESERVE=1000000                     # the whole reserve's cap, zats
CDK_MINTD_MNEMONIC=<24 words>               # the mainnet mint's own ecash key
```

Generate `CDK_MINTD_MNEMONIC` as a fresh 24-word BIP-39 mnemonic on an offline machine, never
reuse the devnet's, and back it up: it signs all the mint's ecash.

`mintd/config.mainnet.toml`: set `[info] url = "https://mint.example.com/mint/"`.

`mainnet/.env` on **guardian N**:

```sh
ZEC_ROLES=guardian:N
ZEC_MINT_URL=https://mint.example.com/mint  # quotes are checked here, over public HTTPS
ZEC_GUARDIAN_LISTEN=0.0.0.0:810N            # reachable from the mint host (firewall: only it)
```

## 7. Web wallet

On a machine with Node 20, from a checkout with the mint host's `mainnet/.env` values:

```sh
cd web && npm ci
ZEC_NETWORK=mainnet ZEC_ENV_FILE=../mainnet/.env npx vite build --outDir dist-mainnet
rsync -a --delete dist-mainnet/ mint:/srv/zec-ecash/web/
```

The page is compiled for mainnet: it shows a MAINNET badge, and it disables itself unless opened at
exactly `ZEC_MINT_URL`'s origin (tokens carry the mint URL).

Caddy: copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`, replace `mint.example.com`, and
`sudo systemctl reload caddy`.

## 8. Start

Guardians first, then the mint host:

```sh
scripts/mainnet-up.sh            # starts this host's ZEC_ROLES, each under a watchdog
scripts/mainnet-up.sh status
scripts/mainnet-up.sh stop
```

The watchdog restarts a part that exits (2 s, doubling to 60 s); `mainnet/logs/watchdog.log`
records every start, exit and restart. To start at boot, a systemd unit per machine:

```ini
# /etc/systemd/system/zec-ecash.service
[Unit]
Description=zec-ecash (MAINNET)
After=network-online.target
Wants=network-online.target

[Service]
# The script starts each part under a background watchdog and exits; the watchdogs stay in this
# unit's cgroup, so `systemctl stop` (and ExecStop) ends them.
Type=oneshot
User=zec
WorkingDirectory=/home/zec/zec-ecash
ExecStart=/home/zec/zec-ecash/scripts/mainnet-up.sh start
ExecStop=/home/zec/zec-ecash/scripts/mainnet-up.sh stop
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

## 9. Before the first transaction

- `scripts/mainnet-up.sh status` on every machine: all parts up.
- On the mint host, `mainnet/logs/processor.log` shows `guardian up` for all three, with the same
  group key, and the reserve wallet's birthday near the current tip.
- `curl https://mint.example.com/reserves`: `"state":"ok"`.
- Each guardian's `verify` reported that all three agree; key shares backed up.
- Firewall: from another machine, the guardians' ports and 9085/9095/51051 are closed.
- Then one small deposit and one small withdrawal, watched end to end.

## 10. Running it

- `/reserves` (HTTP 200 ok, 503 otherwise) is the thing to monitor; `zec-ecash-cli reserves`
  prints it. `RESERVE INVARIANT VIOLATED` and `CRITICAL` lines in `processor.log` need a person.
- A withdrawal flagged `operator_action_required` (reported PAID, then reorged out and expired):
  pay the recipient by other means, then `ZEC_NETWORK=mainnet P resolve <quote_id>`.
- Rotating a guardian's auth secret: `make-auth-key` refuses to overwrite, so move the old
  `guardian-N.auth` aside on both machines, make a new one, copy it, restart both.
- Rotating TLS: `scripts/guardian-ca.sh issue` again with the CA key, copy, restart the guardian.
