#!/usr/bin/env sh
# MAINNET (real ZEC): start, stop or show the parts of the deployment configured on THIS host,
# each under a watchdog that restarts it if it exits. See docs/deploy-mainnet.md.
#
#   scripts/mainnet-up.sh [start]   start what ZEC_ROLES lists (already-running parts are left alone)
#   scripts/mainnet-up.sh stop      stop this host's parts and their watchdogs
#   scripts/mainnet-up.sh status    one line per part, plus the reserve check
#
# mainnet/.env on this host says what runs here, e.g.
#   ZEC_ROLES=processor,mint          the mint host (processor + cdk-mintd; Caddy in front)
#   ZEC_ROLES=guardian:2              a guardian host
#   ZEC_ROLES=processor,mint,guardian:1   a mint host that is also guardian 1
# Each role's files and settings are checked before anything starts; nothing is generated here.
# Ports (loopback unless noted): mintd 9085, processor gRPC 51051, status 9095,
# guardian N 810N (ZEC_GUARDIAN_LISTEN, e.g. 0.0.0.0:8101, so the processor can reach it).
# Logs: mainnet/logs/ (watchdog.log records every start, exit and restart).
set -eu
cd "$(dirname "$0")/.."
export ZEC_NETWORK=mainnet
M=mainnet
ENV_FILE=$M/.env
RUN=$M/run
mkdir -p "$M/logs" "$RUN"
chmod 700 "$M" 2>/dev/null || true

setting() { # setting KEY: value from mainnet/.env only (never .env or the shell)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^["'\'']//; s/["'\'']$//'
}
log() { echo "MAINNET $(date -u '+%FT%TZ') $*" >> "$M/logs/watchdog.log"; }
port_open() { nc -z "${2:-127.0.0.1}" "$1" 2>/dev/null; }
die() { echo "mainnet-up: $*" >&2; exit 1; }

ROLES=$(setting ZEC_ROLES | tr ',' ' ')
has_role() { for r in $ROLES; do [ "$r" = "$1" ] && return 0; done; return 1; }
guardian_ids() { for r in $ROLES; do case "$r" in guardian:[123]) echo "${r#guardian:}" ;; esac; done; }

# --- watchdog: run "$@" forever, restarting with backoff (2 s doubling to 60 s; reset after a
# minute of uptime). Its pid goes to run/<name>.pid; `stop` kills it, then its child.
supervise() {
  name=$1; shift
  (
    trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; log "$name stopped"; exit 0' TERM INT
    delay=2
    while :; do
      started=$(date +%s)
      "$@" >> "$M/logs/$name.stdout" 2>&1 < /dev/null &
      child=$!
      echo "$child" > "$RUN/$name.child"
      log "$name started (pid $child)"
      wait "$child" && code=0 || code=$?
      ran=$(( $(date +%s) - started ))
      [ "$ran" -ge 60 ] && delay=2
      log "$name exited (code $code after ${ran}s); restarting in ${delay}s"
      sleep "$delay"
      delay=$(( delay * 2 )); [ "$delay" -le 60 ] || delay=60
    done
  ) > /dev/null 2>&1 < /dev/null &   # detached from the caller's terminal or pipe
  echo $! > "$RUN/$name.pid"
}
running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
wait_port() { # wait_port <name> <port> <seconds> [host]
  i=0; until port_open "$2" "${4:-127.0.0.1}"; do i=$((i+1)); [ $i -lt "$3" ] || die "$1 did not come up on $2 in ${3}s (see $M/logs/)"; sleep 1; done
  echo "  $1 up (port $2)"
}
listen_host() { # the host part of ZEC_GUARDIAN_LISTEN to probe (0.0.0.0 -> loopback)
  h=${1%:*}; case "$h" in ""|0.0.0.0|"[::]") echo 127.0.0.1 ;; *) echo "$h" ;; esac
}

check_guardian() { # files guardian N needs on its machine
  for f in "guardian-$1.key" frost-pubkeys.json mint.ufvk "guardian-$1.auth" "guardian-$1-tls.crt" "guardian-$1-tls.key"; do
    [ -e "$M/keys/$f" ] || die "guardian $1: $M/keys/$f is missing (docs/deploy-mainnet.md, DKG ceremony / transport)"
  done
  case "$(setting ZEC_MINT_URL)" in https://*) ;; *) die "guardian $1: ZEC_MINT_URL in $ENV_FILE must be the mint's public https:// URL" ;; esac
}
check_processor() {
  for f in mint.ufvk frost-pubkeys.json guardian-1.auth guardian-2.auth guardian-3.auth; do
    [ -e "$M/keys/$f" ] || die "processor: $M/keys/$f is missing"
  done
  [ -n "$(setting ZEC_GUARDIANS)" ] || die "processor: set ZEC_GUARDIANS=https://g1:8101,https://g2:8102,https://g3:8103 in $ENV_FILE"
}
check_mint() {
  [ -n "$(setting CDK_MINTD_MNEMONIC)" ] || die "mint: CDK_MINTD_MNEMONIC missing from $ENV_FILE (the mainnet mint's own; never the devnet's)"
  grep -q 'CHANGE-ME' mintd/config.mainnet.toml && die "mint: set [info] url in mintd/config.mainnet.toml to the public https:// URL"
  command -v cdk-mintd >/dev/null || die "mint: cdk-mintd is not installed (cargo install cdk-mintd --version 0.18.2)"
}

status() {
  echo "MAINNET host roles: ${ROLES:-(none: set ZEC_ROLES in $ENV_FILE)}"
  for id in $(guardian_ids); do
    listen=$(setting ZEC_GUARDIAN_LISTEN); listen=${listen:-127.0.0.1:$((8100 + id))}; p=${listen##*:}
    w=$(running "guardian-$id" && echo "watchdog up" || echo "NO WATCHDOG")
    if port_open "$p" "$(listen_host "$listen")"; then echo "guardian $id     up (port $p), $w"; else echo "guardian $id     DOWN, $w"; fi
  done
  if has_role processor; then
    w=$(running processor && echo "watchdog up" || echo "NO WATCHDOG")
    if port_open 51051; then echo "zec-processor  up (51051), $w"; else echo "zec-processor  DOWN, $w"; fi
    r=$(curl -s -m 3 http://127.0.0.1:9095/reserves | grep -o '"state":"[a-z_]*"' | cut -d'"' -f4)
    echo "reserves       ${r:-no answer} (zec-ecash-cli reserves for the numbers)"
  fi
  if has_role mint; then
    w=$(running mintd && echo "watchdog up" || echo "NO WATCHDOG")
    if curl -s -m 3 http://127.0.0.1:9085/v1/info >/dev/null; then echo "cdk-mintd      up (9085), $w"; else echo "cdk-mintd      DOWN, $w"; fi
  fi
}

stop_all() {
  for f in "$RUN"/*.pid; do
    [ -e "$f" ] || continue
    name=$(basename "$f" .pid)
    kill -TERM "$(cat "$f")" 2>/dev/null || true
    [ -f "$RUN/$name.child" ] && kill -TERM "$(cat "$RUN/$name.child")" 2>/dev/null || true
    rm -f "$f" "$RUN/$name.child"
    echo "stopped $name"
  done
  [ -f "$M/logs/.trim.pid" ] && kill "$(cat "$M/logs/.trim.pid")" 2>/dev/null && rm -f "$M/logs/.trim.pid" || true
}

case "${1:-start}" in
  status) status; exit 0 ;;
  stop) stop_all; exit 0 ;;
  start) ;;
  *) die "usage: scripts/mainnet-up.sh [start|stop|status]" ;;
esac

[ -n "$ROLES" ] || die "set ZEC_ROLES in $ENV_FILE (e.g. processor,mint or guardian:2)"
for r in $ROLES; do case "$r" in processor|mint|guardian:[123]) ;; *) die "unknown role $r in ZEC_ROLES" ;; esac; done
for id in $(guardian_ids); do check_guardian "$id"; done
has_role processor && check_processor
has_role mint && check_mint
echo "*** MAINNET (real ZEC) *** starting on this host: $ROLES"

pkgs=""
[ -n "$(guardian_ids)" ] && pkgs="$pkgs -p guardian"
has_role processor && pkgs="$pkgs -p zec-processor"
[ -z "$pkgs" ] || cargo build --release -q $pkgs

if ! { [ -f "$M/logs/.trim.pid" ] && kill -0 "$(cat "$M/logs/.trim.pid")" 2>/dev/null; }; then
  LOG_STATE=mainnet nohup scripts/log-trim.sh --watch > /dev/null 2>&1 < /dev/null &
fi

for id in $(guardian_ids); do
  if running "guardian-$id"; then echo "guardian $id: already running"; continue; fi
  listen=$(setting ZEC_GUARDIAN_LISTEN); listen=${listen:-127.0.0.1:$((8100 + id))}
  echo "guardian $id (listening on $listen):"
  supervise "guardian-$id" ./target/release/guardian --id "$id" --listen "$listen" serve
  wait_port "guardian $id" "${listen##*:}" 30 "$(listen_host "$listen")"
done

if has_role processor; then
  if running processor; then echo "zec-processor: already running"; else
    echo "zec-processor (builds the Orchard proving key first):"
    supervise processor ./target/release/zec-processor
    wait_port zec-processor 51051 180
  fi
fi

if has_role mint; then
  if running mintd; then echo "cdk-mintd: already running"; else
    echo "cdk-mintd:"
    mkdir -p "$M/mint"
    # The mnemonic only from mainnet/.env, only into cdk-mintd's environment.
    CDK_MINTD_MNEMONIC=$(setting CDK_MINTD_MNEMONIC); export CDK_MINTD_MNEMONIC
    if [ ! -e "$M/mint/cdk-mintd.sqlite" ]; then
      cdk-mintd -w "$M/mint" config init --new-mint --file mintd/config.mainnet.toml | sed 's/^/  /'
    fi
    supervise mintd cdk-mintd -w "$M/mint" --enable-logging
    unset CDK_MINTD_MNEMONIC
    wait_port cdk-mintd 9085 60
  fi
fi
echo
status
