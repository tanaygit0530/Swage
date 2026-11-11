// Runs a TypeScript script by bundling it with esbuild first.
// The SDK's CommonJS build cannot be require()d by plain Node 26 (docs/SPIKES.md), and this
// avoids a TypeScript runner dependency. Usage: node scripts/run.mjs scripts/smoke.ts [args]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('Usage: node scripts/run.mjs <script.ts> [args]');
  process.exit(2);
}
const dir = mkdtempSync(path.join(tmpdir(), 'swage-run-'));
const outfile = path.join(dir, 'script.mjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
  // Prefer ESM builds: some packages' UMD builds use dynamic require() that cannot be bundled.
  mainFields: ['module', 'main'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
process.argv = [process.argv[0], entry, ...args];
try {
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
