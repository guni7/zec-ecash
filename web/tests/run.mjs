// Unit tests (no devnet, no browser): bundles tests/*.test.ts with esbuild and runs them with
// node --test.   npm test
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const here = new URL('.', import.meta.url).pathname;
const tests = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
const out = mkdtempSync(join(tmpdir(), 'zec-ecash-web-tests-'));
try {
  await build({
    entryPoints: tests.map((f) => join(here, f)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: out,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
    define: { __ZEC_NETWORK__: '"regtest"', __ZEC_MINT_URL__: '""' },
  });
  const files = readdirSync(out).filter((f) => f.endsWith('.test.mjs')).map((f) => join(out, f));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
