#!/usr/bin/env sh
# MAINNET health check for a zec-ecash box. Self-contained (copy it to a bare guardian box: no
# repo needed). Run as the service user (gunit). Exit status 1 if anything needs attention.
#
#   sh server-check.sh
#
# What it finds:
#   main host     ~/zec-ecash/mainnet/.env exists (ZEC_MAIN_DIR overrides ~/zec-ecash)
#   guardian(s)   ~/mainnet/keys/guardian-N.key exists (ZEC_GUARDIAN_HOME overrides ~/mainnet)
# What it prints:
#   both          systemd status of this box's units; guardian TLS certificate expiry; free disk
#   main host     public certificate expiry, /reserves, every guardian's reachability (over TLS,
#                 with the guardian CA) and that all report the same group key; the point of sale
#                 (if its seed exists): /health locally and publicly, and what its wallet holds
set -u
MAIN_DIR=${ZEC_MAIN_DIR:-$HOME/zec-ecash}
MAIN_ENV=$MAIN_DIR/mainnet/.env
G_HOME=${ZEC_GUARDIAN_HOME:-$HOME/mainnet}
PROBLEMS=0
bad() { PROBLEMS=$((PROBLEMS + 1)); echo "  !! $*"; }
ok() { echo "  ok $*"; }
setting() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 | sed 's/^["'\'']//; s/["'\'']$//'; }

is_main=0; [ -f "$MAIN_ENV" ] && is_main=1
has_pos=0; [ $is_main = 1 ] && [ -f "$MAIN_DIR/mainnet/keys/pos-wallet.seed" ] && has_pos=1
guardian_ids=""
for f in "$G_HOME"/keys/guardian-[123].key; do
  [ -e "$f" ] && guardian_ids="$guardian_ids $(basename "$f" .key | sed 's/guardian-//')"
done
echo "MAINNET server check on $(hostname) at $(date -u '+%F %TZ')"
echo "  roles:$( [ $is_main = 1 ] && echo ' main host (processor, mint)')${guardian_ids:+ guardian$guardian_ids}"
[ $is_main = 1 ] || [ -n "$guardian_ids" ] || bad "nothing configured here ($MAIN_ENV, $G_HOME/keys/guardian-N.key)"

# Days until a certificate's notAfter (GNU date on Linux, BSD date on macOS).
days_left() {
  end=$(openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')
  [ -n "$end" ] || { echo "?"; return; }
  t=$(date -d "$end" +%s 2>/dev/null || date -j -f '%b %e %T %Y %Z' "$end" +%s 2>/dev/null) || { echo "?"; return; }
  echo $(( (t - $(date +%s)) / 86400 ))
}
check_days() { # check_days <what> <days>
  case "$2" in
    \?) bad "$1: cannot read expiry" ;;
    *) if [ "$2" -lt 14 ]; then bad "$1 expires in $2 days"; else ok "$1 valid for $2 more days"; fi ;;
  esac
}

echo "services:"
if command -v systemctl >/dev/null 2>&1; then
  units=""
  [ $is_main = 1 ] && units="zec-processor zec-mintd caddy"
  [ $has_pos = 1 ] && units="$units zec-pos"
  for id in $guardian_ids; do units="$units zec-guardian@$id"; done
  for u in $units; do
    state=$(systemctl is-active "$u" 2>/dev/null); state=${state:-unknown}
    since=$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)
    restarts=$(systemctl show -p NRestarts --value "$u" 2>/dev/null)
    if [ "$state" = active ]; then ok "$u active since ${since:-?} (restarts: ${restarts:-?})"
    else
      cond=$(systemctl show -p ConditionResult --value "$u" 2>/dev/null)
      [ "$cond" = no ] && bad "$u $state: a ConditionPathExists file is missing (DKG / keys not in place)" || bad "$u $state"
    fi
  done
else
  echo "  (no systemd here: checking ports)"
  for id in $guardian_ids; do
    l=$(setting "$G_HOME/.env" ZEC_GUARDIAN_LISTEN); p=${l##*:}; p=${p:-$((8100 + id))}
    if nc -z 127.0.0.1 "$p" 2>/dev/null; then ok "guardian $id listening on $p"; else bad "guardian $id not listening on $p"; fi
  done
fi

echo "certificates:"
if [ $is_main = 1 ]; then
  url=$(setting "$MAIN_ENV" ZEC_MINT_URL); host=$(echo "$url" | sed -E 's#^https://([^/:]+).*#\1#')
  if [ -n "$host" ]; then
    d=$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | days_left)
    check_days "public certificate for $host" "$d"
  else bad "ZEC_MINT_URL not set in $MAIN_ENV"; fi
fi
for id in $guardian_ids; do
  c=$G_HOME/keys/guardian-$id-tls.crt
  if [ -f "$c" ]; then check_days "guardian $id TLS certificate" "$(days_left < "$c")"; else bad "$c missing"; fi
done

if [ $is_main = 1 ]; then
  echo "reserves:"
  status=$(setting "$MAIN_ENV" ZEC_STATUS_ADDR); status=${status:-127.0.0.1:9095}
  body=$(curl -s -m 5 "http://$status/reserves")
  if [ -z "$body" ]; then bad "no answer from http://$status/reserves (zec-processor down?)"
  else
    state=$(echo "$body" | sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p')
    num() { echo "$body" | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"; }
    line="reserve $(num reserve_zats) zat, outstanding $(num outstanding_zats), in flight $(num in_flight_zats), chain height $(num chain_height)"
    case "$state" in
      ok) ok "$state: $line" ;;
      *) bad "${state:-unknown}: $line (zec-ecash-cli reserves for details)" ;;
    esac
  fi

  echo "guardians (from this host, as the processor reaches them):"
  ca=$(setting "$MAIN_ENV" ZEC_GUARDIAN_CA); ca=${ca:-mainnet/keys/guardian-ca.crt}
  case "$ca" in /*) ;; *) ca=$MAIN_DIR/$ca ;; esac
  [ -f "$ca" ] || bad "guardian CA $ca missing"
  urls=$(setting "$MAIN_ENV" ZEC_GUARDIANS | tr ',' ' ')
  [ -n "$urls" ] || bad "ZEC_GUARDIANS not set in $MAIN_ENV"
  keys=""; n=0; up=0
  for u in $urls; do
    n=$((n + 1))
    s=$(curl -s -m 5 --cacert "$ca" "$u/status")
    gid=$(echo "$s" | sed -n 's/.*"guardian":\([0-9]*\).*/\1/p')
    gk=$(echo "$s" | sed -n 's/.*"group_key":"\([0-9a-f]*\)".*/\1/p')
    if [ -z "$gid" ]; then bad "guardian $n at $u: unreachable (TLS, firewall or down)"
    elif [ "$gid" != "$n" ]; then bad "guardian $n at $u answers as guardian $gid (ZEC_GUARDIANS order?)"
    else up=$((up + 1)); keys="$keys $gk"; ok "guardian $n at $u: up, group key $(echo "$gk" | cut -c1-16)..."; fi
  done
  distinct=$(echo $keys | tr ' ' '\n' | sort -u | grep -c . || true)
  [ "$distinct" -le 1 ] || bad "guardians report different group keys"
  if [ "$up" -ge 2 ]; then ok "$up of $n guardians up: withdrawals can be signed (2 needed)"
  else bad "only $up of $n guardians up: withdrawals CANNOT be signed (2 needed)"; fi

  echo "point of sale:"
  if [ $has_pos = 0 ]; then
    echo "  (not set up: no mainnet/keys/pos-wallet.seed; the web page shows it as offline)"
  else
    pa=$(setting "$MAIN_ENV" ZEC_POS_ADDR); pa=${pa:-127.0.0.1:9090}
    if curl -s -m 5 "http://$pa/health" | grep -q '"ok":true'; then ok "pos answers on $pa"; else bad "pos not answering on $pa (zec-pos.service)"; fi
    pu=$(setting "$MAIN_ENV" ZEC_POS_URL)
    if [ -n "$pu" ]; then
      if curl -s -m 5 "$pu/health" | grep -q '"ok":true'; then ok "public $pu/health reachable (Caddy -> pos)"; else bad "public $pu/health not reachable (Caddy route /pos/* or the pos is down)"; fi
    fi
    if [ -S "$MAIN_DIR/mainnet/pos/admin.sock" ] && [ -x "$MAIN_DIR/target/release/pos" ]; then
      held=$(cd "$MAIN_DIR" && ZEC_NETWORK=mainnet ./target/release/pos balance 2>/dev/null | sed -n 's/.*holds \([0-9]*\) zat.*/\1/p')
      ok "pos wallet holds ${held:-?} zat (move it out: ZEC_NETWORK=mainnet ./target/release/pos sweep)"
    fi
  fi
fi

echo "disk:"
for d in / "$G_HOME" "$MAIN_DIR/mainnet"; do
  [ -d "$d" ] || continue
  # Less than 2 GB free needs attention (logs are capped, but the wallet DBs and mint DB grow).
  df -Pk "$d" | awk -v d="$d" 'NR==2 { free=$4/1024/1024; low=(free < 2); printf "  %s %s: %.1f GB free (%s used)\n", (low ? "!!" : "ok"), d, free, $5; exit low }' \
    || PROBLEMS=$((PROBLEMS + 1))
done

echo
if [ "$PROBLEMS" -eq 0 ]; then echo "all good"; else echo "$PROBLEMS problem(s)"; exit 1; fi
