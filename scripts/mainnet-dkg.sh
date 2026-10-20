#!/usr/bin/env sh
# MAINNET: a fresh 2-of-3 FROST DKG for the mint reserve, into mainnet/keys/:
#   guardian-1.key guardian-2.key guardian-3.key   one secret share per guardian
#   frost-pubkeys.json                              the group's public key package
#   mint.ufvk                                       the reserve's view key (Orchard ak = group key)
# Refuses to run if mainnet/keys/ already holds anything: those keys may control real ZEC, and a
# new DKG would make a different reserve. It never deletes or overwrites a key.
#
# This runs all three guardians on this machine. For real funds, move each guardian-N.key to its
# own machine afterwards (and keep backups); anyone holding two shares can spend the reserve.
#
#   scripts/mainnet-dkg.sh
# ZEC_MAINNET_DIR=<dir> runs it into <dir>/keys instead (only for testing this script).
set -eu
cd "$(dirname "$0")/.."
export ZEC_NETWORK=mainnet
D=${ZEC_MAINNET_DIR:-mainnet}
K=$D/keys

for f in guardian-1.key guardian-2.key guardian-3.key frost-pubkeys.json mint.ufvk; do
  if [ -e "$K/$f" ]; then
    echo "$K/$f exists: refusing to run. MAINNET keys are never replaced by this script." >&2
    exit 1
  fi
done
if [ -d "$K" ] && [ -n "$(ls -A "$K" 2>/dev/null)" ]; then
  echo "$K/ is not empty ($(ls -A "$K" | tr '\n' ' ')): refusing to run." >&2
  exit 1
fi

umask 077  # key files readable by this user only
mkdir -p "$K"
cargo build -q -p guardian -p zec-processor
G=./target/debug/guardian
for part in part1 part2 part3; do
  for id in 1 2 3; do "$G" --dir "$D" --id "$id" dkg "$part"; done
done
# Every guardian must have derived the same public key package.
cmp -s "$K/dkg/pubkeys-1.json" "$K/dkg/pubkeys-2.json"
cmp -s "$K/dkg/pubkeys-1.json" "$K/dkg/pubkeys-3.json"
cp "$K/dkg/pubkeys-1.json" "$K/frost-pubkeys.json"
rm -rf "$K/dkg"
ZEC_MINT_UFVK="$K/mint.ufvk" ZEC_FROST_PUBKEYS="$K/frost-pubkeys.json" ./target/debug/zec-processor make-ufvk
for id in 1 2 3; do "$G" --dir "$D" --id "$id" check-ufvk; done
echo
echo "MAINNET keys written to $K/ (mode 600). Next: back up each guardian-N.key separately, move"
echo "each to its guardian's machine, and fund nothing until a test deposit and withdrawal work."
