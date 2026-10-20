#!/usr/bin/env sh
# A private CA for the guardians' TLS certificates (the processor trusts it as ZEC_GUARDIAN_CA).
# Run on the processor host (or the operator's offline machine); the CA key never leaves it.
#
#   scripts/guardian-ca.sh init  <dir>                  # <dir>/guardian-ca.key (600), guardian-ca.crt
#   scripts/guardian-ca.sh issue <dir> <N> <host-or-ip> # <dir>/guardian-N-tls.key (600), guardian-N-tls.crt
#
# Give guardian N its guardian-N-tls.{crt,key} (into <state>/keys/ on its machine) and keep
# guardian-ca.crt on the processor host (<state>/keys/guardian-ca.crt). <host-or-ip> must be what
# the processor's ZEC_GUARDIANS URL for guardian N uses. EC P-256 keys, certificates valid 2 years.
set -eu
cmd=${1:-}; dir=${2:-}
[ -n "$cmd" ] && [ -n "$dir" ] || { echo "usage: $0 init <dir> | issue <dir> <N> <host-or-ip>" >&2; exit 1; }
umask 077
mkdir -p "$dir"
case "$cmd" in
  init)
    [ ! -e "$dir/guardian-ca.key" ] || { echo "$dir/guardian-ca.key exists; refusing to replace the CA" >&2; exit 1; }
    openssl ecparam -name prime256v1 -genkey -noout -out "$dir/guardian-ca.key"
    cat > "$dir/ca.ext" <<'EOF'
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
    openssl req -new -key "$dir/guardian-ca.key" -subj "/CN=zec-ecash guardian CA" -out "$dir/ca.csr"
    openssl x509 -req -in "$dir/ca.csr" -signkey "$dir/guardian-ca.key" -days 3650 -sha256 \
      -extfile "$dir/ca.ext" -out "$dir/guardian-ca.crt" 2>/dev/null
    rm -f "$dir/ca.csr" "$dir/ca.ext"
    chmod 644 "$dir/guardian-ca.crt"
    echo "CA: $dir/guardian-ca.crt (public; the processor's ZEC_GUARDIAN_CA), key $dir/guardian-ca.key (keep private)"
    ;;
  issue)
    n=${3:-}; host=${4:-}
    [ -n "$n" ] && [ -n "$host" ] || { echo "usage: $0 issue <dir> <N> <host-or-ip>" >&2; exit 1; }
    [ -e "$dir/guardian-ca.key" ] || { echo "no CA in $dir: run $0 init $dir first" >&2; exit 1; }
    case "$host" in
      *[!0-9.]*) san="DNS:$host" ;;   # a hostname
      *) san="IP:$host" ;;            # an IPv4 address
    esac
    openssl ecparam -name prime256v1 -genkey -noout -out "$dir/guardian-$n-tls.key"
    cat > "$dir/leaf.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
    openssl req -new -key "$dir/guardian-$n-tls.key" -subj "/CN=guardian-$n" -out "$dir/leaf.csr"
    openssl x509 -req -in "$dir/leaf.csr" -CA "$dir/guardian-ca.crt" -CAkey "$dir/guardian-ca.key" \
      -CAcreateserial -days 730 -sha256 -extfile "$dir/leaf.ext" -out "$dir/guardian-$n-tls.crt" 2>/dev/null
    rm -f "$dir/leaf.csr" "$dir/leaf.ext" "$dir/guardian-ca.srl"
    chmod 644 "$dir/guardian-$n-tls.crt"
    echo "guardian $n: $dir/guardian-$n-tls.crt + .key for $san (copy both to guardian $n's <state>/keys/)"
    ;;
  *) echo "usage: $0 init <dir> | issue <dir> <N> <host-or-ip>" >&2; exit 1 ;;
esac
