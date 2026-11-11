// Bundles the VS Code integration tests into CommonJS for Mocha (out/test/integration/*.test.js).
// Type checking happens separately with tsconfig.integration.json. `vscode` stays external.
import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const entries = readdirSync('test/integration')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/integration/${f}`);

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outdir: 'out/test/integration',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'warning',
});
