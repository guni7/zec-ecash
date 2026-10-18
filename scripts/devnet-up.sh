#!/usr/bin/env sh
# Start the regtest devnet in order and wait for each piece, or show what's running.
#   scripts/devnet-up.sh          zebrad -> guardians 1-3 -> zec-processor -> cdk-mintd -> web (if set up)
#   scripts/devnet-up.sh status   one line per service, plus which guardians are up
# Logs: devnet/{zebrad,guardian-N,processor,mintd,web}.log. Already-running services are left alone.
set -eu
cd "$(dirname "$0")/.."
K=devnet/keys
RPC=http://127.0.0.1:18232/

height() {
  curl -s -m 2 -H 'content-type: application/json' \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' "$RPC" \
    | sed -n 's/.*"result":\([0-9]*\).*/\1/p'
}
port_open() { nc -z 127.0.0.1 "$1" 2>/dev/null; }
zebrad_up() { [ -n "$(height)" ]; }
mintd_up() { curl -s -m 2 http://127.0.0.1:8085/v1/info >/dev/null; }
wait_for() { # wait_for <what> <seconds> <command...>
  what=$1; secs=$2; shift 2; i=0
  until "$@"; do
    i=$((i+1)); if [ $i -ge "$secs" ]; then echo "  $what did not come up in ${secs}s (see its log)" >&2; exit 1; fi
    sleep 1
  done
  echo "  $what up"
}

status() {
  h=$(height); if [ -n "$h" ]; then echo "zebrad         up (height $h)"; else echo "zebrad         DOWN"; fi
  up=""; down=""
  for id in 1 2 3; do
    if curl -s -m 2 "http://127.0.0.1:710$id/status" | grep -q '"guardian"'; then up="$up $id"; else down="$down $id"; fi
  done
  n=$(echo $up | wc -w | tr -d ' ')
  if [ "$n" -ge 2 ]; then verdict="can sign"; else verdict="CANNOT SIGN (need 2 of 3)"; fi
  echo "guardians      up:${up:- none}  down:${down:- none}  -> $n/3, $verdict"
  if port_open 50051; then echo "zec-processor  up (127.0.0.1:50051)"; else echo "zec-processor  DOWN"; fi
  if curl -s -m 2 http://127.0.0.1:8085/v1/info >/dev/null; then echo "cdk-mintd      up (127.0.0.1:8085)"; else echo "cdk-mintd      DOWN"; fi
  if port_open 5173; then
    if curl -s -m 2 --cacert web/certs/rootCA.pem "$(mint_url)/v1/info" >/dev/null 2>&1; then
      echo "web            up ($(mint_url) reaches the mint)"
    else echo "web            up, but $(mint_url)/v1/info fails (network changed? scripts/set-mint-host.sh)"; fi
  else echo "web            DOWN (optional: web wallet)"; fi
}

mint_url() { sed -n 's/^ZEC_MINT_URL=//p' .env 2>/dev/null | tail -1; }

if [ "${1:-up}" = status ]; then status; exit 0; fi
[ "${1:-up}" = up ] || { echo "usage: scripts/devnet-up.sh [status]" >&2; exit 1; }

# Fail loudly on missing keys; nothing here creates them.
for f in guardian-1.key guardian-2.key guardian-3.key frost-pubkeys.json mint.ufvk user-wallet.seed; do
  [ -e "$K/$f" ] || { echo "$K/$f is missing: restore devnet/keys/ or run scripts/devnet-reset.sh --new-keys" >&2; exit 1; }
done
grep -q '^CDK_MINTD_MNEMONIC=' .env || { echo ".env has no CDK_MINTD_MNEMONIC" >&2; exit 1; }
cargo build -q -p guardian -p zec-processor

echo "zebrad:"
if ! zebrad_up; then
  nohup zebrad -c devnet/zebrad-regtest.toml start > devnet/zebrad.log 2>&1 &
  wait_for zebrad 60 zebrad_up
else echo "  already running"; fi
if [ "$(height)" = 0 ]; then
  ./devnet/mine.sh 1 >/dev/null
  echo "  mined block 1 (wallet birthdays start from it)"
fi

echo "guardians:"
for id in 1 2 3; do
  if port_open "710$id"; then echo "  guardian $id already running"; continue; fi
  nohup ./target/debug/guardian --id "$id" serve > "devnet/guardian-$id.log" 2>&1 &
  wait_for "guardian $id" 20 port_open "710$id"
done

echo "zec-processor:"
if port_open 50051; then echo "  already running"; else
  nohup ./target/debug/zec-processor > devnet/processor.log 2>&1 &
  wait_for "zec-processor (builds the Orchard proving key first)" 180 port_open 50051
fi

echo "cdk-mintd:"
if mintd_up; then echo "  already running"; else
  set -a; . ./.env; set +a
  if [ ! -e devnet/mint/cdk-mintd.sqlite ]; then
    mkdir -p devnet/mint
    cdk-mintd -w devnet/mint config init --new-mint --file mintd/config.toml | sed 's/^/  /'
  fi
  nohup cdk-mintd -w devnet/mint --enable-logging > devnet/mintd.log 2>&1 &
  wait_for cdk-mintd 60 mintd_up
fi
echo "web:"
if [ ! -e web/certs/dev.pem ] || [ ! -d web/node_modules ]; then
  echo "  not set up (optional; see README \"Web wallet\")"
elif port_open 5173; then echo "  already running"
else
  # One background process with every stream redirected, so nothing keeps the caller's
  # stdout open (a `( cd web && ... & )` wrapper would, hanging pipelines like `| sed`).
  nohup sh -c 'cd web && exec npx vite' > devnet/web.log 2>&1 < /dev/null &
  wait_for "web (https :5173)" 30 port_open 5173
fi
echo
status
