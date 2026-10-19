#!/usr/bin/env sh
# Bound the devnet's log files. Our own processes (zec-processor, guardians, CLI) already rotate
# by size (devlog crate); this covers what we don't control: zebrad, cdk-mintd and the web server
# write to devnet/logs/*.log (opened in append mode by devnet-up.sh, so trimming in place is
# safe), and cdk-mintd also keeps daily files in devnet/mint/logs/.
#   scripts/log-trim.sh          trim once
#   scripts/log-trim.sh --watch  trim every 30 s (started by devnet-up.sh; pid in devnet/logs/.trim.pid)
set -eu
cd "$(dirname "$0")/.."
MAX_MB=20     # a file larger than this ...
KEEP_MB=2     # ... is cut down to its last KEEP_MB
MINT_DAYS=7   # cdk-mintd daily files kept

trim_once() {
  for f in devnet/logs/*.log devnet/logs/*.stdout devnet/mint/logs/*; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" | tr -d ' ')
    if [ "$size" -gt $((MAX_MB * 1024 * 1024)) ]; then
      tail -c $((KEEP_MB * 1024 * 1024)) "$f" > "$f.trim" && cat "$f.trim" > "$f" && rm -f "$f.trim"
      echo "$(date '+%F %T') trimmed $f from $((size / 1024 / 1024)) MB to ${KEEP_MB} MB"
    fi
  done
  # oldest cdk-mintd daily files beyond MINT_DAYS
  if [ -d devnet/mint/logs ]; then
    ls -1t devnet/mint/logs/* 2>/dev/null | tail -n +$((MINT_DAYS + 1)) | while read -r old; do rm -f "$old"; done
  fi
}

if [ "${1:-}" = "--watch" ]; then
  mkdir -p devnet/logs
  echo $$ > devnet/logs/.trim.pid
  while :; do trim_once >> devnet/logs/log-trim.out 2>&1; sleep 30; done
else
  trim_once
fi
