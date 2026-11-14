// npm run screenshots: drives the real review UI in a test copy of VS Code and captures each
// state over the Chrome DevTools protocol into docs/images (no OS screen-recording permission
// needed). The demo workspace holds no secrets.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const PORT = 9339;
const out = 'docs/images';
mkdirSync(out, { recursive: true });
const shotDir = mkdtempSync(path.join(tmpdir(), 'swage-shot-markers-'));

await esbuild.build({
  entryPoints: readdirSync('test/screenshots')
    .filter((f) => f.endsWith('.shot.ts'))
    .map((f) => `test/screenshots/${f}`),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outdir: 'out/test/screenshots',
  outExtension: { '.js': '.js' },
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

const child = spawn('npx', ['vscode-test', '--config', '.vscode-test.screenshots.mjs'], {
  env: { ...process.env, SWAGE_SHOT_DIR: shotDir },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const exited = new Promise((resolve) => child.on('exit', resolve));

async function workbenchSocket() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('VS Code DevTools endpoint not found');
}

function capture(wsUrl, file) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }),
      );
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else {
        writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
        resolve();
      }
    };
    ws.onerror = () => reject(new Error('DevTools socket error'));
  });
}

// The states test/screenshots/review.shot.ts drives, in order, for each theme.
const names = ['dark', 'light'].flatMap((theme) =>
  ['review-diff', 'review-file-controls', 'review-comment', 'review-applied'].map(
    (state) => `${state}-${theme}`,
  ),
);
let ws;
for (const name of names) {
  const ready = path.join(shotDir, `${name}.ready`);
  for (let i = 0; i < 1200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(ready)) throw new Error(`state ${name} never became ready`);
  ws ??= await workbenchSocket();
  await capture(ws, path.join(out, `${name}.png`));
  console.log(`captured ${out}/${name}.png`);
  writeFileSync(path.join(shotDir, `${name}.done`), '');
}
await exited;
