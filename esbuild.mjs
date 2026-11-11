// Bundles the extension host code into dist/extension.js.
import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

// tree-sitter runtime and grammars used by src/context (blueprint section 7).
const WASM_SRC = 'node_modules/@vscode/tree-sitter-wasm/wasm';
const WASM_FILES = [
  'tree-sitter.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
];
mkdirSync('dist/wasm', { recursive: true });
for (const file of WASM_FILES) copyFileSync(`${WASM_SRC}/${file}`, `dist/wasm/${file}`);

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
});

// The agent panel webview: Preact bundled for the browser, with its stylesheet. No CDN.
const webview = await esbuild.context({
  entryPoints: { webview: 'src/ui/webview/main.tsx', 'webview-style': 'src/ui/webview/style.css' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
});

if (watch) {
  await ctx.watch();
  await webview.watch();
} else {
  await ctx.rebuild();
  await webview.rebuild();
  await ctx.dispose();
  await webview.dispose();
}
