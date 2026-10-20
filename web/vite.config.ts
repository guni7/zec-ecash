// Dev server for the demo wallet: HTTPS on every interface (leaf cert from
// scripts/set-mint-host.sh) and a same-origin proxy /mint/* -> the HTTP mint, because an HTTPS
// page can't call an http:// mint (mixed content) and the phone can't reach 127.0.0.1 anyway.
// The mint URL wallets use (and tokens carry) is https://<host>:5173/mint, <host> being the
// name in ZEC_MINT_URL (.env); nothing here hard-codes a hostname or IP.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const MINT = process.env.ZEC_MINT_UPSTREAM ?? 'http://127.0.0.1:8085';

/** The host part of ZEC_MINT_URL (environment first, then ../.env). */
function mintHost(): string | undefined {
  let url = process.env.ZEC_MINT_URL;
  if (!url) {
    try {
      url = readFileSync('../.env', 'utf8').match(/^ZEC_MINT_URL=(.*)$/m)?.[1]?.trim();
    } catch {
      /* no .env */
    }
  }
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  // Pre-bundle every dependency at startup. Otherwise Vite discovers new imports on first page
  // load, re-bundles and forces a reload, and an already-open phone gets "504 Outdated Optimize
  // Dep" (a blank page) until it reloads.
  optimizeDeps: {
    include: ['@cashu/cashu-ts', 'qrcode', 'qr-scanner', '@noble/curves/secp256k1.js'],
  },
  server: {
    host: true, // all interfaces
    port: 5173,
    // Vite only answers Host headers it knows (DNS-rebinding guard). IPs and localhost always
    // pass; also allow the configured mint host and any mDNS name.
    allowedHosts: ['.local', ...(mintHost() ? [mintHost()!] : [])],
    strictPort: true,
    https: {
      cert: readFileSync('certs/dev.pem'),
      key: readFileSync('certs/dev-key.pem'),
    },
    proxy: {
      '/mint': {
        target: MINT,
        changeOrigin: true,
        ws: true, // NUT-17 subscriptions (the CLI waits for quotes over websockets)
        rewrite: (path) => path.replace(/^\/mint/, ''),
      },
      // zec-processor's status endpoints (JSON): the reserve check, and why a withdrawal can't
      // be quoted (the mint only says "Unit unsupported").
      '/reserves': {
        target: process.env.ZEC_STATUS_UPSTREAM ?? 'http://127.0.0.1:8095',
        changeOrigin: true,
      },
      '/withdrawal-quote': {
        target: process.env.ZEC_STATUS_UPSTREAM ?? 'http://127.0.0.1:8095',
        changeOrigin: true,
      },
      // NUT-18 point of sale (crates/pos); its requests' HTTP transport points here too.
      '/pos': {
        target: process.env.ZEC_POS_UPSTREAM ?? 'http://127.0.0.1:8090',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pos/, ''),
      },
    },
  },
});
