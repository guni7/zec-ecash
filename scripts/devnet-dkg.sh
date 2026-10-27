#!/usr/bin/env sh
# DEVNET ONLY: the 2-of-3 FROST DKG for the regtest devnet, all on this machine. It runs the
# same distributed ceremony as mainnet (guardian dkg / guardian verify, docs/deploy-mainnet.md),
# with three directories standing in for the three guardian machines and `cp` standing in for
# the operator carrying files (round-2 files only to their recipient). Then it gathers the
# results into devnet/keys/: guardian-N.key, frost-pubkeys.json, mint.ufvk.
# Refuses ZEC_NETWORK=mainnet. Normally run by scripts/devnet-reset.sh --new-keys.
set -eu
cd "$(dirname "$0")/.."
if [ "${ZEC_NETWORK:-regtest}" != regtest ]; then
  echo "scripts/devnet-dkg.sh is for the regtest devnet only (ZEC_NETWORK=$ZEC_NETWORK)." >&2
  echo "MAINNET keys come from the distributed ceremony in docs/deploy-mainnet.md." >&2
  exit 1
fi
export ZEC_NETWORK=regtest
K=devnet/keys
for f in $K/guardian-1.key $K/guardian-2.key $K/guardian-3.key $K/frost-pubkeys.json $K/mint.ufvk; do
  if [ -e "$f" ]; then
    echo "$f exists: these keys control the reserve. Use scripts/devnet-reset.sh --new-keys." >&2
    exit 1
  fi
done
cargo build -q -p guardian -p zec-processor
G=./target/debug/guardian
C=devnet/dkg-ceremony           # m1 m2 m3 = the three "machines"
rm -rf "$C"
dkg() { "$G" --dir "$C/m$1" --id "$1" dkg --threshold 2 --participants 3 >/dev/null; }

for i in 1 2 3; do dkg $i; done                          # round 1
for i in 1 2 3; do for j in 1 2 3; do                     # round-1 files go to everyone
  [ $i = $j ] || cp "$C/m$i/dkg/outbox/round1-from-$i.json" "$C/m$j/dkg/inbox/"
done; done
for i in 1 2 3; do dkg $i; done                          # round 2
for i in 1 2 3; do for j in 1 2 3; do                     # round-2 files ONLY to their recipient
  [ $i = $j ] || mv "$C/m$i/dkg/outbox/round2-from-$i-to-$j.json" "$C/m$j/dkg/inbox/"
done; done
for i in 1 2 3; do dkg $i; done                          # key shares

# The processor host makes the UFVK from the public key package; every guardian gets a copy.
ZEC_FROST_PUBKEYS="$C/m1/keys/frost-pubkeys.json" ZEC_MINT_UFVK="$C/mint.ufvk" \
  ./target/debug/zec-processor make-ufvk >/dev/null
for i in 1 2 3; do cp "$C/mint.ufvk" "$C/m$i/keys/"; done
for i in 1 2 3; do "$G" --dir "$C/m$i" --id "$i" verify >/dev/null; done
for i in 1 2 3; do for j in 1 2 3; do
  [ $i = $j ] || cp "$C/m$i/dkg/outbox/verify-$i.json" "$C/m$j/dkg/inbox/"
done; done
for i in 1 2 3; do "$G" --dir "$C/m$i" --id "$i" verify | tail -1; done

mkdir -p "$K"
for i in 1 2 3; do mv "$C/m$i/keys/guardian-$i.key" "$K/"; done
mv "$C/m1/keys/frost-pubkeys.json" "$C/mint.ufvk" "$K/"
rm -rf "$C"
for id in 1 2 3; do "$G" --id "$id" check-ufvk; done
