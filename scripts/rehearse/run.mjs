// `node scripts/rehearse.mjs run`: checks TrueForge and the Flask clone, writes the clone's
// Swage settings (Flask's .gitignore covers .vscode/, so git status stays clean), builds the
// extension and the rehearsal suite, and runs it in a test VS Code. Evidence goes to
// docs/evidence/<run-id>/ (runs/*.json, logs/*.log, meta.json).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

// Chosen on measured latency and quota (docs/evidence/notes.md): two separate free-tier buckets.
const DEFAULT_PROFILES = [
  {
    name: 'primary',
    label: 'Gemini Flash Lite (latest)',
    kind: 'hosted',
    trueforgeModel: 'google-gemini/gemini-flash-lite-latest',
  },
  {
    name: 'fallback-1',
    label: 'Gemini 3.5 Flash Lite',
    kind: 'hosted',
    trueforgeModel: 'google-gemini/gemini-3-5-flash-lite',
  },
  // A thinking model with its own free-tier quota: slower to its first token, so a longer wait.
  {
    name: 'fallback-2',
    label: 'Gemini 3.5 Flash',
    kind: 'hosted',
    trueforgeModel: 'google-gemini/gemini-3-5-flash',
    params: { max_tokens: 8192 },
    timeouts: { firstTokenMs: 90_000 },
  },
  {
    name: 'fallback-3',
    label: 'Gemini 3.1 Flash Lite',
    kind: 'hosted',
    trueforgeModel: 'google-gemini/gemini-3-1-flash-lite',
  },
  // Local and free of quotas: the last resort when every free tier is rate-limited.
  {
    name: 'fallback-4',
    label: 'Ollama Qwen 7B',
    kind: 'local',
    trueforgeModel: 'ollama/qwen-2-5-coder-7b',
  },
];

export async function main({ repo, dir, args, flag, step, say, sh }) {
  const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
  step(1, `TrueForge at ${baseUrl}`);
  const version = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .then((b) => b.version)
    .catch(() => undefined);
  if (!version) {
    say('TrueForge is not running. Start it with trueforge/start.sh, then run this again.');
    process.exit(1);
  }
  say(`TrueForge ${version}`);

  step(2, `Flask clone ${dir}`);
  if (!existsSync(path.join(dir, '.venv'))) {
    say('No clone or venv yet: run node scripts/rehearse.mjs setup first.');
    process.exit(1);
  }
  sh('git', ['reset', '--quiet', '--hard', 'HEAD'], { cwd: dir });
  sh('git', ['clean', '-fdq', '-e', '.venv', '-e', '.vscode'], { cwd: dir });
  say(`HEAD ${sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })}, clean`);

  step(3, 'Model profiles for the rehearsal');
  const profilesFile = flag('--profiles');
  const profiles = profilesFile
    ? (await import('yaml')).parse(readFileSync(profilesFile, 'utf8')).profiles
    : DEFAULT_PROFILES;
  for (const p of profiles) say(`${p.name}: ${p.trueforgeModel}`);
  mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  writeFileSync(
    path.join(dir, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'swage.truefoundry.baseUrl': baseUrl, 'swage.autoStart': false, 'swage.models': profiles }, null, 2)}\n`,
  );
  const status = sh('git', ['status', '--porcelain'], { cwd: dir });
  if (status !== '') throw new Error(`.vscode/settings.json shows in git status:\n${status}`);
  say('.vscode/settings.json written (ignored by Flask, git status clean)');

  step(4, 'Build the extension and the rehearsal suite');
  sh('npm', ['run', 'build'], { cwd: repo });
  await esbuild.build({
    entryPoints: [path.join(repo, 'test/rehearse/rehearse.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: path.join(repo, 'out/test/rehearse/rehearse.test.js'),
    external: ['vscode', 'mocha'],
    logLevel: 'warning',
  });

  const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const out = path.join(repo, 'docs', 'evidence', runId);
  mkdirSync(out, { recursive: true });
  const swageCommit = sh('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const dirty =
    sh(
      'git',
      ['status', '--porcelain', '--', 'src', 'test', 'scripts', 'trueforge', 'package.json'],
      { cwd: repo },
    ) !== '';
  writeFileSync(
    path.join(out, 'run.json'),
    `${JSON.stringify({ runId, swageCommit, swageDirty: dirty, trueforge: version, profiles, tasks: flag('--tasks', 'cancel,a,toggle,undo,b,c') }, null, 2)}\n`,
  );
  step(
    5,
    `Rehearsal ${runId} (Swage ${swageCommit.slice(0, 8)}${dirty ? ', uncommitted changes' : ''})`,
  );
  say(
    'Steps: cancel before Task A; Task A runs (run 1 toggles block 1); Task B runs; Task A + Task B applied, then Undo twice; Task C runs.',
  );
  say('Do not type in the test VS Code window while it runs.');
  const env = {
    ...process.env,
    REHEARSE_DIR: dir,
    REHEARSE_OUT: out,
    REHEARSE_TASKS: flag('--tasks', 'cancel,a,toggle,undo,b,c'),
    REHEARSE_RUNS_A: flag('--runs-a', '5'),
    REHEARSE_RUNS_B: flag('--runs-b', '3'),
    REHEARSE_RUNS_C: flag('--runs-c', '3'),
    REHEARSE_FALLBACK_MODEL: flag('--fallback', profiles[0]?.trueforgeModel ?? ''),
    REHEARSE_TRUEFORGE: baseUrl,
  };
  const code = await new Promise((resolve) => {
    const child = spawn('npx', ['vscode-test', '--config', '.vscode-test.rehearse.mjs'], {
      cwd: repo,
      env,
      stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  step(6, 'Results');
  const runs = existsSync(path.join(out, 'runs')) ? readdirSync(path.join(out, 'runs')).sort() : [];
  for (const f of runs) {
    const r = JSON.parse(readFileSync(path.join(out, 'runs', f), 'utf8'));
    say(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id}: ${r.summary}`);
  }
  say(`Evidence: docs/evidence/${runId}/  (then: node scripts/rehearse.mjs report)`);
  if (args.includes('--strict') && code !== 0) process.exit(code);
}
