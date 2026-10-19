# Source me (bash or zsh):  source scripts/env.sh
# Exports every variable in the repo's .env (CDK_MINTD_MNEMONIC, ZEC_MINT_URL, ZEC_MINT_CA, ...)
# into this shell, with ZEC_MINT_CA made absolute so it works from any directory. Fails loudly
# (without closing your shell) if ZEC_MINT_URL or ZEC_MINT_CA is missing.
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_zec_src="${(%):-%x}"'
elif [ -n "${BASH_VERSION:-}" ]; then
  _zec_src="${BASH_SOURCE[0]}"
else
  _zec_src="scripts/env.sh"   # other shells: source it from the repo root
fi
_zec_root="$(cd "$(dirname "$_zec_src")/.." && pwd)"
_zec_fail() { echo "scripts/env.sh: $*" >&2; unset -f _zec_fail; unset _zec_src _zec_root; return 1; }

if [ ! -f "$_zec_root/.env" ]; then
  _zec_fail "$_zec_root/.env not found"
elif ! grep -q '^ZEC_MINT_URL=.' "$_zec_root/.env"; then
  _zec_fail "ZEC_MINT_URL missing from .env: run scripts/set-mint-host.sh"
elif ! grep -q '^ZEC_MINT_CA=.' "$_zec_root/.env"; then
  _zec_fail "ZEC_MINT_CA missing from .env: run scripts/set-mint-host.sh"
else
  set -a
  . "$_zec_root/.env"
  set +a
  case "$ZEC_MINT_CA" in /*) ;; *) ZEC_MINT_CA="$_zec_root/$ZEC_MINT_CA" ;; esac
  export ZEC_MINT_CA
  if [ ! -f "$ZEC_MINT_CA" ]; then
    _zec_fail "ZEC_MINT_CA file $ZEC_MINT_CA not found: run scripts/set-mint-host.sh"
  else
    echo "zec-ecash env: ZEC_MINT_URL=$ZEC_MINT_URL  ZEC_MINT_CA=$ZEC_MINT_CA"
    unset -f _zec_fail; unset _zec_src _zec_root
  fi
fi
