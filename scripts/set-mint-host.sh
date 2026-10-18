#!/usr/bin/env sh
# Point the devnet's public mint URL at a hostname (default: this Mac's mDNS name, which
# survives network changes) in one step:
#   - reissue the web server's leaf certificate (web/certs/dev.pem, dev-key.pem) from the
#     EXISTING mkcert root, for <host>, localhost, 127.0.0.1 and the current LAN IP;
#   - ZEC_MINT_URL=https://<host>:5173/mint in .env (ZEC_MINT_CA kept);
#   - [info] url in mintd/config.toml, `config apply`, restart the mint;
#   - restart the Vite dev server.
#
#   scripts/set-mint-host.sh                  # "$(scutil --get LocalHostName).local"
#   scripts/set-mint-host.sh 192.168.1.22     # IP fallback for networks that block mDNS
#   scripts/set-mint-host.sh mymac.lan        # any name the phone can resolve
#
# The root CA is never created, copied or printed here: the phone trusts web/certs/rootCA.pem,
# and the script refuses to run unless mkcert's root (whose key stays in `mkcert -CAROOT`) is that
# same certificate. Only the leaf changes, so the phone's installed root stays valid.
# First-time setup (no web/certs/rootCA.pem yet): run with --init to adopt mkcert's root.
set -eu
cd "$(dirname "$0")/.."

INIT=0
if [ "${1:-}" = "--init" ]; then INIT=1; shift; fi
HOST="${1:-$(scutil --get LocalHostName).local}"
HOST=$(printf '%s' "$HOST" | tr 'A-Z' 'a-z')
IP=$(ipconfig getifaddr en0 2>/dev/null || true)
NEW_URL="https://$HOST:5173/mint"

command -v mkcert >/dev/null || { echo "mkcert not found: brew install mkcert" >&2; exit 1; }
CA_DIR="$(mkcert -CAROOT)"
[ -f "$CA_DIR/rootCA.pem" ] && [ -f "$CA_DIR/rootCA-key.pem" ] || {
  echo "mkcert has no root CA in $CA_DIR; refusing to create one here." >&2
  echo "(A new root would have to be installed on the phone again.)" >&2
  exit 1
}
mkdir -p web/certs
if [ -f web/certs/rootCA.pem ]; then
  cmp -s "$CA_DIR/rootCA.pem" web/certs/rootCA.pem || {
    echo "mkcert's root in $CA_DIR is not web/certs/rootCA.pem (the root the phone trusts)." >&2
    echo "Refusing to issue a certificate the phone wouldn't accept." >&2
    exit 1
  }
elif [ "$INIT" = 1 ]; then
  cp "$CA_DIR/rootCA.pem" web/certs/rootCA.pem   # the public certificate only
  echo "adopted mkcert's root: web/certs/rootCA.pem (install this on the phone)"
else
  echo "web/certs/rootCA.pem missing; first-time setup: scripts/set-mint-host.sh --init [host]" >&2
  exit 1
fi

echo "issuing web/certs/dev.pem for: $HOST localhost 127.0.0.1 ${IP:-(no en0 IP)}"
# shellcheck disable=SC2086
CAROOT="$CA_DIR" mkcert -cert-file web/certs/dev.pem -key-file web/certs/dev-key.pem \
  "$HOST" localhost 127.0.0.1 $IP 2>&1 | grep -E "certificate is at|expire" || true

# .env: replace or add ZEC_MINT_URL; keep (or add) ZEC_MINT_CA.
OLD_URL=$(sed -n 's/^ZEC_MINT_URL=//p' .env 2>/dev/null | tail -1)
touch .env
[ -z "$(tail -c1 .env)" ] || printf '\n' >> .env
if grep -q '^ZEC_MINT_URL=' .env; then
  sed -i.bak "s|^ZEC_MINT_URL=.*|ZEC_MINT_URL=$NEW_URL|" .env && rm -f .env.bak
else
  printf 'ZEC_MINT_URL=%s\n' "$NEW_URL" >> .env
fi
grep -q '^ZEC_MINT_CA=' .env || printf 'ZEC_MINT_CA=web/certs/rootCA.pem\n' >> .env

# Mint config: [info] url, then apply and restart the mint.
sed -i.bak "s|^url = \".*\"|url = \"$NEW_URL/\"|" mintd/config.toml && rm -f mintd/config.toml.bak
grep -q "^url = \"$NEW_URL/\"" mintd/config.toml || { echo "could not set [info] url in mintd/config.toml" >&2; exit 1; }
set -a; . ./.env; set +a
mkdir -p devnet/mint
if [ -e devnet/mint/cdk-mintd.sqlite ]; then
  cdk-mintd --work-dir devnet/mint config apply --file mintd/config.toml | sed 's/^/  /'
fi
stop() {
  pgrep -f "$1" >/dev/null || return 0
  pkill -TERM -f "$1" || true
  i=0; while pgrep -f "$1" >/dev/null && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
}
stop 'cdk-mintd'
stop 'web/node_modules/.bin/vite'   # the Vite dev server (reloads the new certificate on start)
./scripts/devnet-up.sh | sed -n '/^cdk-mintd:/,$p'

echo
echo "old mint URL: ${OLD_URL:-(none)}"
echo "new mint URL: $NEW_URL"
echo "phone:        https://$HOST:5173   (IP fallback if mDNS is blocked: scripts/set-mint-host.sh ${IP:-<ip>})"
if [ -n "$OLD_URL" ] && [ "$OLD_URL" != "$NEW_URL" ]; then
  echo "WARNING: ecash minted under $OLD_URL now counts as a different mint. It is still"
  echo "         redeemable at the same mint with: zec-ecash-cli --mint $OLD_URL ..."
fi
