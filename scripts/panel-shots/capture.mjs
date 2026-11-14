// npm run screenshots:panel: renders the real agent panel bundle (dist/webview.js and
// dist/webview-style.css) in headless Chrome, one page per state and theme, fed with the host
// messages in states.mjs, and saves docs/images/panel-<state>-<theme>.png. No VS Code, no
// network, no keys: the data is scripted. Needs Google Chrome (or CHROME=/path/to/chrome).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { STATES } from './states.mjs';
import { THEMES } from './themes.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(root, 'docs', 'images');
const work = path.join(root, 'out', 'panel-shots');
const chrome =
  process.env.CHROME ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!chrome) throw new Error('Google Chrome not found; set CHROME=/path/to/chrome');
if (!existsSync(path.join(root, 'dist', 'webview.js'))) throw new Error('Run npm run build first');

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const only = process.argv.slice(2);
const WIDTH = Number(process.env.PANEL_WIDTH ?? 440);
const HEIGHT = 900;

for (const [name, state] of Object.entries(STATES)) {
  if (only.length > 0 && !only.includes(name)) continue;
  for (const [themeName, theme] of Object.entries(THEMES)) {
    const vars = Object.entries(theme.vars)
      .map(([k, v]) => `${k}: ${v};`)
      .join(' ');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>:root { ${vars} } html, body { height: ${HEIGHT}px; width: ${WIDTH}px; overflow: hidden; }</style>
<link rel="stylesheet" href="../../dist/webview-style.css"></head>
<body class="${theme.class}"><div id="root"></div>
<script>
  const STATE = ${JSON.stringify(state)};
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (msg.type !== 'ready') return;
      setTimeout(() => {
        for (const m of STATE.messages) window.postMessage(m, '*');
        setTimeout(() => {
          if (STATE.collapseBar) document.querySelector('[aria-label="Hide the changed files"]')?.click();
          for (const sel of STATE.click ?? []) document.querySelector(sel)?.click();
          setTimeout(() => {
            if (STATE.scrollTo) {
              const log = document.querySelector('[role="log"]');
              const el = document.querySelector(STATE.scrollTo);
              if (log && el) log.scrollTop = el.offsetTop - 120;
            }
          }, 100);
        }, 200);
      }, 50);
    },
  });
</script>
<script src="../../dist/webview.js"></script></body></html>`;
    const page = path.join(work, `${name}-${themeName}.html`);
    writeFileSync(page, html);
    const file = path.join(out, `panel-${name}-${themeName}.png`);
    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        '--allow-file-access-from-files',
        `--window-size=${WIDTH},${HEIGHT}`,
        '--virtual-time-budget=4000',
        `--screenshot=${file}`,
        `file://${page}`,
      ],
      { stdio: 'ignore' },
    );
    console.log(`captured ${path.relative(root, file)}`);
  }
}
