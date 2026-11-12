import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet } from '../../src/changeset/changeSet';
import {
  createShadow,
  describeChanges,
  diffSnapshots,
  prepareCommand,
  venvProgram,
  runProcess,
  scrubbedEnv,
  snapshot,
} from '../../src/mcp/shadow';
import { PathGuard } from '../../src/safety/pathGuard';

let root: string;
let outside: string;

function write(rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-ws-')));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-outside-')));
  write('src/app.py', 'VALUE = 1\n');
  write('src/old.py', 'old\n');
  write('README.md', '# app\n');
  write('.git/config', '[core]\n');
  write('.env', 'TOKEN=x\n');
  write('node_modules/pkg/index.js', '1\n');
  write('.venv/bin/python', '#!/bin/sh\n');
  writeFileSync(path.join(outside, 'target.txt'), 'outside\n');
  symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('createShadow', () => {
  it('copies the workspace without ignored paths and symlinks, and applies the staged overlay', async () => {
    const cs = new ChangeSet('t', {
      read: (p) =>
        Promise.resolve(
          existsSync(path.join(root, p)) ? readFileSync(path.join(root, p), 'utf8') : undefined,
        ),
    });
    cs.declareContext({
      plan: [],
      files: ['src/app.py', 'src/new.py', 'src/old.py'].map((p) => ({ path: p, reason: 'r' })),
    });
    await cs.stage({
      kind: 'edit',
      path: 'src/app.py',
      edits: [{ find: 'VALUE = 1', replace: 'VALUE = 2' }],
    });
    await cs.stage({ kind: 'write', path: 'src/new.py', content: 'NEW = True\n' });
    await cs.stage({ kind: 'delete', path: 'src/old.py' });

    const shadow = await createShadow(root, new PathGuard({ root }), cs);
    const files = [...(await snapshot(shadow.dir)).keys()].sort();
    expect(files).toEqual(['README.md', 'src/app.py', 'src/new.py']);
    expect(readFileSync(path.join(shadow.dir, 'src/app.py'), 'utf8')).toBe('VALUE = 2\n');
    expect(shadow.overlaid).toEqual(['src/app.py', 'src/new.py', 'src/old.py']);
    expect(readFileSync(path.join(root, 'src/app.py'), 'utf8')).toBe('VALUE = 1\n');
    expect(existsSync(path.join(root, 'src/old.py'))).toBe(true);
    await shadow.dispose();
    expect(existsSync(shadow.dir)).toBe(false);
  });
});

describe('snapshots', () => {
  it('reports created, modified and deleted files', () => {
    const before = new Map([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
    const after = new Map([
      ['a', '1'],
      ['b', 'x'],
      ['d', '4'],
    ]);
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual({ created: ['d'], modified: ['b'], deleted: ['c'] });
    expect(describeChanges(changes)).toBe('+ d (created)\n~ b (modified)\n- c (deleted)');
    expect(describeChanges({ created: [], modified: [], deleted: [] })).toMatch(
      /did not change any files/,
    );
  });
});

describe('environment and argv', () => {
  it('drops every variable outside the allowlist, keys and tokens included', () => {
    const env = scrubbedEnv(
      { PYTHONPATH: '/x' },
      {
        PATH: '/bin',
        HOME: '/h',
        GROQ_API_KEY: 'k',
        AWS_SECRET_ACCESS_KEY: 's',
        TRUEFORGE_TOKEN: 't',
      },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: '/x',
    });
  });

  it('resolves a relative venv interpreter against the real workspace and puts the shadow src first', () => {
    const shadowDir = mkdtempSync(path.join(tmpdir(), 'swage-sh-'));
    mkdirSync(path.join(shadowDir, 'src'));
    const prepared = prepareCommand(
      ['.venv/bin/python', '-m', 'pytest', 'tests'],
      root,
      shadowDir,
      'pytest',
    );
    expect(prepared.argv).toEqual([
      path.join(root, '.venv/bin/python'),
      '-m',
      'pytest',
      'tests',
      '-p',
      'no:cacheprovider',
    ]);
    expect(prepared.env['PYTHONPATH']).toBe(
      `${path.join(shadowDir, 'src')}${path.delimiter}${shadowDir}`,
    );
    expect(prepareCommand(['npm', 'test'], root, root).argv).toEqual(['npm', 'test']);
    // A bare pytest or python uses the workspace venv (no global pytest needed on the judge's machine).
    mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
    writeFileSync(path.join(root, '.venv', 'bin', 'pytest'), '');
    expect(
      prepareCommand(['pytest', 'tests/test_cli.py', '-q'], root, root, 'pytest').argv[0],
    ).toBe(path.join(root, '.venv', 'bin', 'pytest'));
    expect(prepareCommand(['python3', '-m', 'pytest'], root, root, 'pytest').argv[0]).toBe(
      'python3',
    );
    expect(venvProgram(root, 'node')).toBeUndefined();
    rmSync(shadowDir, { recursive: true, force: true });
  });
});

describe('runProcess', () => {
  const node = process.execPath;

  it('runs without a shell and captures redacted output and the exit code', async () => {
    const key = 'gs' + 'k_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    const r = await runProcess(
      [
        node,
        '-e',
        `console.log("key ${key}"); console.error("err; echo injected"); process.exit(3)`,
      ],
      {
        cwd: root,
        env: scrubbedEnv(),
        timeoutMs: 10_000,
      },
    );
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('[REDACTED:groq_key]');
    expect(r.output).not.toContain(key);
    expect(r.output).toContain('err; echo injected');
    expect(r.timedOut).toBe(false);
  });

  it('keeps only the tail of long output', async () => {
    const r = await runProcess(
      [node, '-e', 'for (let i = 0; i < 5000; i++) console.log("line " + i)'],
      {
        cwd: root,
        env: scrubbedEnv(),
        timeoutMs: 10_000,
        maxOutputBytes: 1000,
      },
    );
    expect(r.output.length).toBeLessThanOrEqual(1000);
    expect(r.output).toContain('line 4999');
    expect(r.droppedBytes).toBeGreaterThan(0);
  });

  it('kills the whole process tree on timeout', async () => {
    const grandchild = `require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000); console.log(process.pid)"], { stdio: "inherit" }); setInterval(()=>{}, 1000);`;
    const r = await runProcess([node, '-e', grandchild], {
      cwd: root,
      env: scrubbedEnv(),
      timeoutMs: 500,
      killGraceMs: 200,
    });
    expect(r.timedOut).toBe(true);
    const childPid = Number(/(\d+)/.exec(r.output)?.[1]);
    await new Promise((res) => setTimeout(res, 400));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('kills the process tree on abort', async () => {
    const controller = new AbortController();
    const pending = runProcess([node, '-e', 'setInterval(()=>{}, 1000)'], {
      cwd: root,
      env: scrubbedEnv(),
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const r = await pending;
    expect(r.cancelled).toBe(true);
    expect(r.ms).toBeLessThan(5000);
    const already = new AbortController();
    already.abort();
    expect(
      (
        await runProcess([node, '-e', 'setInterval(()=>{}, 1000)'], {
          cwd: root,
          env: scrubbedEnv(),
          timeoutMs: 30_000,
          signal: already.signal,
        })
      ).cancelled,
    ).toBe(true);
  });

  it('reports a missing program', async () => {
    const r = await runProcess(['definitely-not-a-program-xyz'], {
      cwd: root,
      env: scrubbedEnv(),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBeNull();
    expect(r.output).toMatch(/ENOENT/);
  });
});
