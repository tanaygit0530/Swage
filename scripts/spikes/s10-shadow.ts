/**
 * Spike S10 (blueprint section 14): can pytest in a shadow copy import the staged code?
 * Copies the Flask checkout (without .git and .venv) to a temp folder, stages a marker into
 * src/flask/cli.py there, and runs a marker test with the checkout's own virtualenv, first as is,
 * then with PYTHONPATH pointing at the shadow's src. The real checkout is never modified.
 * Usage: SWAGE_FLASK_DIR=~/Desktop/Hackthons/flask npm run spike -- scripts/spikes/s10-shadow.ts
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const flask = process.env['SWAGE_FLASK_DIR'];
if (!flask || !existsSync(path.join(flask, 'src', 'flask', 'cli.py')))
  throw new Error('Set SWAGE_FLASK_DIR to the Flask checkout');
const python = path.join(flask, '.venv', 'bin', 'python');
if (!existsSync(python))
  throw new Error(
    `No virtualenv at ${python}; create it with python3 -m venv .venv && .venv/bin/pip install -e . pytest`,
  );

const shadow = mkdtempSync(path.join(tmpdir(), 'swage-shadow-'));
const started = Date.now();
cpSync(flask, shadow, {
  recursive: true,
  filter: (src) => !/\/(\.git|\.venv|__pycache__|\.pytest_cache)(\/|$)/.test(src),
});
console.log(`shadow copy at ${shadow} in ${Date.now() - started} ms`);

appendFileSync(path.join(shadow, 'src', 'flask', 'cli.py'), '\nSWAGE_STAGED_MARKER = "staged"\n');
writeFileSync(
  path.join(shadow, 'tests', 'test_swage_marker.py'),
  [
    'import flask',
    'from flask import cli',
    '',
    '',
    'def test_staged_code_is_imported():',
    '    print("flask imported from", flask.__file__)',
    '    assert getattr(cli, "SWAGE_STAGED_MARKER", None) == "staged"',
    '',
  ].join('\n'),
);

const run = (label: string, env: NodeJS.ProcessEnv): void => {
  const t0 = Date.now();
  const r = spawnSync(
    python,
    ['-m', 'pytest', 'tests/test_swage_marker.py', '-q', '-s', '-p', 'no:cacheprovider'],
    {
      cwd: shadow,
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    },
  );
  const where = /flask imported from (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
  console.log(`\n=== ${label}: exit ${r.status} in ${Date.now() - t0} ms`);
  console.log(`flask imported from: ${where}`);
  console.log(`staged code seen: ${r.status === 0 ? 'YES' : 'NO'}`);
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-3).join('\n');
  console.log(tail);
};

run('as is (editable install points at the real checkout)', process.env);
run('with PYTHONPATH=<shadow>/src', { ...process.env, PYTHONPATH: path.join(shadow, 'src') });

const real = spawnSync('git', ['status', '--short'], { cwd: flask, encoding: 'utf8' });
console.log(
  `\nreal checkout git status: ${real.stdout.trim() === '' ? 'clean' : real.stdout.trim()}`,
);
rmSync(shadow, { recursive: true, force: true });
