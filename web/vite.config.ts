// Dev server for the demo wallet: HTTPS on every interface (leaf cert from
// scripts/set-mint-host.sh) and a same-origin proxy /mint/* -> the HTTP mint, because an HTTPS
// page can't call an http:// mint (mixed content) and the phone can't reach 127.0.0.1 anyway.
// The mint URL wallets use (and tokens carry) is https://<host>:<port>/mint, <host> being the
// name in ZEC_MINT_URL; nothing here hard-codes a hostname or IP.
//
// ZEC_NETWORK=mainnet: settings come from ../mainnet/.env only (never ../.env or the shell, which
// may hold the devnet's), upstream defaults are the mainnet ports (+1000), the page shows a
// MAINNET badge, and it refuses to work unless it is opened at the configured ZEC_MINT_URL.
// Every upstream can be set from the environment: ZEC_MINT_UPSTREAM, ZEC_STATUS_UPSTREAM,
// ZEC_POS_UPSTREAM; ZEC_WEB_PORT sets this server's port, ZEC_WEB_CERT / ZEC_WEB_KEY its TLS files. For a production build (`vite build`,
// served by Caddy, see deploy/Caddyfile.example) the same network and mint URL are compiled in.
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const NETWORK = process.env.ZEC_NETWORK ?? 'regtest';
if (NETWORK !== 'regtest' && NETWORK !== 'mainnet') {
  throw new Error(`ZEC_NETWORK must be regtest or mainnet, not ${NETWORK}`);
}
const MAINNET = NETWORK === 'mainnet';
/** Mainnet services listen on the regtest port + 1000 (see zec-network). */
const port = (regtest: number) => (MAINNET ? regtest + 1000 : regtest);

/** KEY from the env file of this network (mainnet: ../mainnet/.env only). */
function setting(key: string): string | undefined {
  if (!MAINNET && process.env[key]) return process.env[key];
  try {
    // ZEC_ENV_FILE: another settings file (staging, tests); never needed normally.
    const file = readFileSync(process.env.ZEC_ENV_FILE ?? (MAINNET ? '../mainnet/.env' : '../.env'), 'utf8');
    return file.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const MINT_URL = setting('ZEC_MINT_URL')?.replace(/\/+$/, '');
if (MAINNET && !MINT_URL) throw new Error('MAINNET web wallet: set ZEC_MINT_URL in mainnet/.env');
const upstream = (name: string, regtestPort: number) => process.env[name] ?? `http://127.0.0.1:${port(regtestPort)}`;
const MINT = upstream('ZEC_MINT_UPSTREAM', 8085);
const STATUS = upstream('ZEC_STATUS_UPSTREAM', 8095);
const POS = upstream('ZEC_POS_UPSTREAM', 8090);

function mintHost(): string | undefined {
  try {
    return MINT_URL ? new URL(MINT_URL).hostname : undefined;
  } catch {
    return undefined;
  }
}

/** MAINNET: no devnet wording in the HTML itself (the script also sets it, but the static page
 * must be right even before or without it). */
const mainnetHtml: Plugin = {
  name: 'zec-mainnet-html',
  transformIndexHtml(html) {
    if (!MAINNET) return html;
    return html
      .replace(/<title>(.*?)<\/title>/, '<title>MAINNET · $1</title>')
      .replace(/<div id="network-badge" class="network-badge" role="alert" hidden>/, '<div id="network-badge" class="network-badge" role="alert">')
      .replace(
        /(<div id="banner" class="banner" role="alert">)[\s\S]*?(<\/div>)/,
        '$1\n      MAINNET: real ZEC. Experimental mint; keep only small amounts here. Ecash lives only in this\n      browser: clearing site data loses it.\n    $2',
      );
  },
};

export default defineConfig(({ command }) => ({
  plugins: [mainnetHtml],
  // Compiled into the page: which network, and the mint URL it must be opened at.
  define: {
    __ZEC_NETWORK__: JSON.stringify(NETWORK),
    __ZEC_MINT_URL__: JSON.stringify(MINT_URL ?? ''),
  },
  // Pre-bundle every dependency at startup. Otherwise Vite discovers new imports on first page
  // load, re-bundles and forces a reload, and an already-open phone gets "504 Outdated Optimize
  // Dep" (a blank page) until it reloads.
  optimizeDeps: {
    include: ['@cashu/cashu-ts', 'qrcode', 'qr-scanner', '@noble/curves/secp256k1.js'],
  },
  server: {
    host: true, // all interfaces
    port: Number(process.env.ZEC_WEB_PORT ?? port(5173)),
    // Vite only answers Host headers it knows (DNS-rebinding guard). IPs and localhost always
    // pass; also allow the configured mint host and any mDNS name.
    allowedHosts: ['.local', ...(mintHost() ? [mintHost()!] : [])],
    strictPort: true,
    // Dev server only: a production build (served by Caddy) needs no certificate here.
    https:
      command === 'serve'
        ? {
            cert: readFileSync(process.env.ZEC_WEB_CERT ?? 'certs/dev.pem'),
            key: readFileSync(process.env.ZEC_WEB_KEY ?? 'certs/dev-key.pem'),
          }
        : undefined,
    proxy: {
      '/mint': {
        target: MINT,
        changeOrigin: true,
        ws: true, // NUT-17 subscriptions (the CLI waits for quotes over websockets)
        rewrite: (path) => path.replace(/^\/mint/, ''),
      },
      // zec-processor's status endpoints (JSON): the reserve check, and why a deposit or
      // withdrawal can't be quoted (the mint only says "Invalid payment request" / "Unit unsupported").
      '/reserves': { target: STATUS, changeOrigin: true },
      '/deposit-quote': { target: STATUS, changeOrigin: true },
      '/withdrawal-quote': { target: STATUS, changeOrigin: true },
      // NUT-18 point of sale (crates/pos); its requests' HTTP transport points here too.
      '/pos': {
        target: POS,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pos/, ''),
      },
    },
  },
}));
