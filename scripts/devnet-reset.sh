#!/usr/bin/env sh
# Reset the regtest devnet's chain-dependent state together, so reserves and issued ecash
# start in step. Stops zebrad, zec-processor, cdk-mintd and all guardians, then deletes:
#   devnet/zebra-state, devnet/mint (cdk-mintd work dir), every wallet DB in devnet/
#   (*.sqlite incl. mint-reserve and user-wallet, *.redb = the CLI ecash wallet), the processor
#   DB, guardian-*.signed.json (per-quote state tied to the mint DB), logs.
# Never touches devnet/keys/, .env, or anything in mainnet/ (MAINNET processes, on ports +1000,
# are left running: processes are stopped by their devnet ports, not by name).
#
#   scripts/devnet-reset.sh              keep keys (same addresses; miner_address stays valid)
#   scripts/devnet-reset.sh --new-keys   also new FROST keys (DKG), mint.ufvk, user and ecash
#                                        wallet seeds; asks for confirmation (--yes skips it)
set -eu
cd "$(dirname "$0")/.."
# Devnet scripts always work on regtest, whatever the shell's ZEC_NETWORK says.
export ZEC_NETWORK=regtest
# Paranoia: devnet/ must be its own directory, never (a link to) mainnet/.
if [ -L devnet ] || { [ -d mainnet ] && [ "$(cd devnet && pwd -P)" = "$(cd mainnet && pwd -P)" ]; }; then
  echo "devnet/ is a link or the same directory as mainnet/: refusing to reset" >&2; exit 1
fi
NEW_KEYS=0; YES=0
for a in "$@"; do
  case "$a" in
    --new-keys) NEW_KEYS=1 ;;
    --yes) YES=1 ;;
    *) echo "usage: scripts/devnet-reset.sh [--new-keys [--yes]]" >&2; exit 1 ;;
  esac
done
K=devnet/keys

if [ "$NEW_KEYS" = 1 ] && [ "$YES" = 0 ]; then
  cat <<'WARN'
--new-keys replaces everything in devnet/keys/: the guardians' FROST key shares, mint.ufvk,
frost-pubkeys.json, and the user and ecash wallet seeds. Anything still held by the old
FROST key (the mint reserve) becomes unspendable. Fine on a devnet; never on real funds.
WARN
  printf 'Type "new keys" to continue: '
  read -r answer < /dev/tty
  [ "$answer" = "new keys" ] || { echo "aborted; nothing changed"; exit 1; }
fi

stop() { # stop processes matching $1 (only devnet-specific command lines): SIGTERM, wait, KILL
  pgrep -f "$1" >/dev/null || return 0
  pkill -TERM -f "$1" || true
  i=0; while pgrep -f "$1" >/dev/null && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
  pkill -KILL -f "$1" 2>/dev/null || true
  echo "stopped $2"
}
stop_port() { # stop_port <port> <name>: stop whatever listens on this devnet port (SIGTERM, wait,
  # KILL). By port, not by process name, so MAINNET processes (ports +1000) are never touched.
  pids=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  kill -TERM $pids 2>/dev/null || true
  i=0; while [ -n "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ] && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
  pids=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null || true
  echo "stopped $2"
}
stop_port 50051 zec-processor
stop_port 8090 pos
for id in 1 2 3; do stop_port 710$id "guardian $id"; done
stop_port 8085 cdk-mintd
stop 'zebrad -c devnet/zebrad-regtest.toml' zebrad
stop 'scripts/log-trim.sh --watch' log-trimmer
pkill -TERM -f 'web/node_modules/.bin/vite' 2>/dev/null || true

echo "deleting chain-dependent state:"
for p in devnet/zebra-state devnet/mint devnet/*.sqlite devnet/*.sqlite-shm devnet/*.sqlite-wal \
         devnet/*.sqlite-journal devnet/*.redb devnet/guardian-*.signed.json devnet/*.log devnet/logs devnet/quote.json; do
  if [ -e "$p" ]; then rm -rf "$p"; echo "  deleted $p"; fi
done

if [ "$NEW_KEYS" = 1 ]; then
  echo "deleting keys:"
  for p in $K/guardian-*.key $K/frost-pubkeys.json $K/mint.ufvk $K/user-wallet.seed $K/ecash-wallet.seed $K/dkg; do
    if [ -e "$p" ]; then rm -rf "$p"; echo "  deleted $p"; fi
  done
  echo "new keys:"
  scripts/dkg
  cargo run -q -p devwallet -- new
  cargo run -q -p zec-ecash-cli -- init
  ADDR=$(cargo run -q -p devwallet -- address)
  echo
  echo "New user wallet address: $ADDR"
  echo "Update miner_address in devnet/zebrad-regtest.toml to it before starting zebrad."
  echo "Reserves held by the old FROST key are now unspendable (devnet only)."
fi

echo "kept devnet/keys/:"
for f in guardian-1.key guardian-2.key guardian-3.key frost-pubkeys.json mint.ufvk user-wallet.seed ecash-wallet.seed; do
  if [ -e "$K/$f" ]; then echo "  $K/$f"; else echo "  $K/$f  MISSING"; fi
done
echo "kept .env (CDK_MINTD_MNEMONIC)"
echo "next: scripts/devnet-up.sh && ./devnet/mine.sh 110"
