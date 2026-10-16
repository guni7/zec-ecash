#!/usr/bin/env sh
# Mine N regtest blocks instantly (default 1). Coinbase needs 100 confirmations
# before it can be spent, so mine 110 once after setting miner_address.
N="${1:-1}"
curl -s -H 'content-type: application/json' \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"generate\",\"params\":[$N]}" \
  http://127.0.0.1:18232/ | head -c 300; echo
