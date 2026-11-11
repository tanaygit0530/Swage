/**
 * npm run break-primary: makes the primary model unreachable for Task C (blueprint section 10),
 * so Swage must fall back with no click. Undo with npm run restore-primary.
 *
 *   --mode url     (default) a real bad base URL: registers the TrueForge custom provider
 *                  `swage-broken` on a closed local port (TrueForge reports ECONNREFUSED at once)
 *                  and points the primary at swage-broken/primary. Needs TrueForge running.
 *   --mode fake    the fake model: points the primary at swage-fake/primary-down, which answers
 *                  401 (run npm run fake-model so TrueForge knows that model).
 *   --workspace <dir>   edit <dir>/.vscode/settings.json (swage.models), for example ../flask
 *   --profiles <file>   also or instead edit a profiles file (default: config/models.yaml/.yml/.json
 *                       when present)
 *
 * The primary keeps its display name, so the banner still says "because Gemini ...". Only the
 * primary's model, label and connect/first-token timers change; fallbacks are untouched. No key
 * is read, written or printed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { describeError } from '../src/client/client';
import { breakPrimaryText, formatOf } from './lib/primary';
import { loadState, saveState, STATE_FILE, type BreakState } from './lib/primaryState';

const BROKEN_PROVIDER = 'swage-broken';
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = (flag('--mode') ?? 'url') as 'url' | 'fake';
if (mode !== 'url' && mode !== 'fake') throw new Error('--mode must be url or fake');
const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';

function targets(): string[] {
  const out: string[] = [];
  const ws = flag('--workspace');
  if (ws) out.push(path.resolve(ws, '.vscode', 'settings.json'));
  const explicit = flag('--profiles');
  if (explicit) out.push(path.resolve(explicit));
  else
    for (const f of ['config/models.yaml', 'config/models.yml', 'config/models.json'])
      if (existsSync(f)) {
        out.push(path.resolve(f));
        break;
      }
  return out.filter((f) => existsSync(f));
}

/** A local port nothing listens on: bind, read the port, close. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

if (loadState()) {
  console.error(
    `The primary is already broken (${STATE_FILE}). Run npm run restore-primary first.`,
  );
  process.exit(1);
}
const files = targets();
if (files.length === 0) {
  console.error(
    'No profiles to edit. Pass --workspace <folder with .vscode/settings.json> or create config/models.yaml.',
  );
  process.exit(1);
}

let brokenModel = 'swage-fake/primary-down';
if (mode === 'url') {
  const port = await closedPort();
  const unreachable = `http://127.0.0.1:${port}/v1`;
  try {
    const sdk = new TrueForge({ baseUrl, timeoutInSeconds: 30 });
    await sdk.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom',
        name: BROKEN_PROVIDER,
        baseUrl: unreachable,
        models: [
          {
            name: 'primary',
            modelId: 'primary',
            properties: { contextLength: 32768, maxOutputTokens: 4096 },
          },
        ],
      },
    });
  } catch (err) {
    console.error(
      `Could not register ${BROKEN_PROVIDER} in TrueForge at ${baseUrl}: ${describeError(err)}`,
    );
    process.exit(1);
  }
  brokenModel = `${BROKEN_PROVIDER}/primary`;
  console.log(
    `TrueForge provider ${BROKEN_PROVIDER} -> ${unreachable} (closed port: connection refused)`,
  );
}

const changed: BreakState['files'][number][] = [];
for (const file of files) {
  try {
    const r = breakPrimaryText(readFileSync(file, 'utf8'), formatOf(file), brokenModel);
    writeFileSync(file, r.text);
    changed.push({ file, original: r.original });
    console.log(`${file}: primary ${r.original.trueforgeModel} -> ${brokenModel}`);
    if (r.profiles < 2)
      console.log(`  warning: ${file} has no fallback profile, so Swage has nothing to switch to.`);
  } catch (err) {
    console.log(`${file}: skipped (${(err as Error).message})`);
  }
}
if (changed.length === 0) {
  console.error('Nothing changed.');
  process.exit(1);
}
saveState({
  version: 1,
  createdAt: new Date().toISOString(),
  mode,
  brokenModel,
  ...(mode === 'url' ? { provider: BROKEN_PROVIDER } : {}),
  baseUrl,
  files: changed,
});
console.log(
  `\nPrimary broken. VS Code picks up the change at once. Undo with: npm run restore-primary`,
);
