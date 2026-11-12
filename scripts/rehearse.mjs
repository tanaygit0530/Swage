#!/usr/bin/env node
// Rehearsal for the demo tasks (blueprint sections 10, 11 and 17). Guides each step, drives the
// real extension in a test VS Code against the running TrueForge and real models, and records
// evidence under docs/evidence/<run-id>/. Nothing touches the Flask clone's git history; each
// run resets the clone and `git status` is checked after every task.
//
//   node scripts/rehearse.mjs setup              clean Flask 3.1.3 clone + venv + baseline tests
//   node scripts/rehearse.mjs run [--tasks cancel,a,toggle,undo,b,c] [--runs-a 5 --runs-b 3 --runs-c 3]
//   node scripts/rehearse.mjs report             docs/EVIDENCE.md from docs/evidence/*
//
// Options: --dir <flask clone> (default: <tmp>/swage-rehearsal/flask-3.1.3), --profiles <yaml>
// TrueForge must be running (trueforge/start.sh) for `run`. No key is read or printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const FLASK_URL = 'https://github.com/pallets/flask.git';
const FLASK_TAG = '3.1.3';
const FLASK_COMMIT = '22d924701a6ae2e4cd01e9a15bbaf3946094af65';
// Flask 3.1.3's uv.lock pins for Python 3.10 or newer: runtime dependencies and the `tests`
// group. Unpinned, pip picks Werkzeug 3.1.9, and test_bad_environ_raises_bad_request fails.
const TEST_DEPS = [
  'werkzeug==3.1.5',
  'click==8.3.1',
  'jinja2==3.1.6',
  'itsdangerous==2.2.0',
  'blinker==1.9.0',
  'markupsafe==3.0.3',
  'asgiref==3.11.0',
  'greenlet==3.3.1',
  'pytest==9.0.2',
  'python-dotenv==1.2.1',
];

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const dir = path.resolve(
  flag('--dir', path.join(tmpdir(), 'swage-rehearsal', `flask-${FLASK_TAG}`)),
);
const python = path.join(
  dir,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

const step = (n, text) => console.log(`\n\x1b[1m[${n}] ${text}\x1b[0m`);
const say = (text) => console.log(`    ${text}`);
const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/** Secrets never reach the evidence: the same patterns as src/safety/redact.ts, kept simple here. */
export function redact(text) {
  return String(text)
    .replace(/\b(sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '***')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
    .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)[^\s"',}]{6,}/gi, '$1***');
}

function pythonVersion(exe) {
  const r = spawnSync(exe, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function pythonOk(exe) {
  const v = pythonVersion(exe);
  if (!v) return false;
  const [major, minor] = v.split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 10);
}

/** The first Python 3.10+ among SWAGE_PYTHON, versioned names on PATH, python3, and usual installs. */
function findPython() {
  const home = process.env.HOME ?? '';
  const candidates = [
    process.env.SWAGE_PYTHON,
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/opt/anaconda3/bin/python3',
    '/opt/miniconda3/bin/python3',
    path.join(home, 'anaconda3', 'bin', 'python3'),
    path.join(home, 'miniconda3', 'bin', 'python3'),
  ].filter(Boolean);
  return candidates.find((c) => pythonOk(c));
}

function pytest(argv = []) {
  const t0 = Date.now();
  const r = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...argv], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  const summary = out.trim().split('\n').at(-1) ?? '';
  return { ok: r.status === 0, summary, ms: Date.now() - t0, out };
}

function setup() {
  step(1, `Clean checkout of Flask ${FLASK_TAG} in ${dir} (outside the Swage repository)`);
  if (dir.startsWith(repo))
    throw new Error('The Flask clone must live outside the Swage repository.');
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    sh('git', [
      '-c',
      'advice.detachedHead=false',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      FLASK_TAG,
      FLASK_URL,
      dir,
    ]);
  }
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: dir });
  if (head !== FLASK_COMMIT) throw new Error(`Expected commit ${FLASK_COMMIT}, found ${head}`);
  sh('git', ['reset', '--quiet', '--hard', FLASK_COMMIT], { cwd: dir });
  sh('git', ['clean', '-fdxq', '-e', '.venv', '-e', '.vscode'], { cwd: dir });
  say(
    `HEAD ${head.slice(0, 8)} (tag ${FLASK_TAG}); git status clean: ${sh('git', ['status', '--porcelain'], { cwd: dir }) === ''}`,
  );

  step(2, 'Virtual environment with Flask (editable) and its pinned test dependencies');
  // pytest 9.0.2 (Flask's pin) needs Python 3.10 or newer, and macOS's /usr/bin/python3 is 3.9.
  // Use the newest 3.10+ interpreter found, and replace a venv built on an older one.
  if (existsSync(python) && !pythonOk(python))
    rmSync(path.join(dir, '.venv'), { recursive: true, force: true });
  if (!existsSync(python)) {
    const base = findPython();
    if (!base)
      throw new Error(
        'No Python 3.10 or newer found. Install one, or set SWAGE_PYTHON to its path.',
      );
    say(`Creating .venv with ${base} (${pythonVersion(base)})`);
    sh(base, ['-m', 'venv', '.venv'], { cwd: dir });
  }
  // Old pips (21.x ships with Python 3.9) cannot install a pyproject.toml project in editable mode.
  sh(
    python,
    ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--upgrade', 'pip'],
    { cwd: dir },
  );
  sh(
    python,
    ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-e', '.', ...TEST_DEPS],
    { cwd: dir },
  );
  const versions = sh(python, [
    '-c',
    'import sys, flask, pytest, importlib.metadata as m; print(sys.version.split()[0], m.version("flask"), pytest.__version__)',
  ]).split(' ');
  say(`Python ${versions[0]}, Flask ${versions[1]}, pytest ${versions[2]}`);

  step(3, 'Baseline: the full Flask test suite before any change');
  const all = pytest();
  say(all.summary);
  const cli = pytest(['tests/test_cli.py']);
  say(`tests/test_cli.py: ${cli.summary}`);
  const out = path.join(repo, 'docs', 'evidence', 'baseline');
  mkdirSync(out, { recursive: true });
  const baseline = {
    flask: { tag: FLASK_TAG, commit: head, dir: '<tmp>/swage-rehearsal/flask-3.1.3' },
    python: versions[0],
    flaskVersion: versions[1],
    pytest: versions[2],
    testDeps: TEST_DEPS,
    suite: { ok: all.ok, summary: all.summary, ms: all.ms },
    testCli: { ok: cli.ok, summary: cli.summary, ms: cli.ms },
    swageCommit: sh('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(out, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(path.join(out, 'pytest-full.log'), redact(all.out.replaceAll(dir, '<flask>')));
  say(`Recorded docs/evidence/baseline/ (baseline.json, pytest-full.log)`);
  if (!all.ok)
    say('Baseline is not green: record the failures as the starting point before rehearsing.');
}

if (command === 'setup') setup();
else if (command === 'run' || command === 'report') {
  const mod = await import(`./rehearse/${command}.mjs`);
  await mod.main({ repo, dir, python, args, flag, step, say, sh, redact, pytest });
} else {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 13)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  );
}
