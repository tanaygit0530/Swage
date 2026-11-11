import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_IGNORES, PathGuard, parseIgnoreFile } from '../../../src/safety/pathGuard';

let base: string;
let root: string;
let outside: string;
let guard: PathGuard;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-pathguard-')));
  root = path.join(base, 'flask');
  outside = path.join(base, 'secret-place');
  mkdirSync(path.join(root, 'src', 'flask'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'src', 'flask', 'cli.py'), 'import click\n');
  writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0\n');
  symlinkSync(outside, path.join(root, 'escape-dir'));
  symlinkSync(path.join(outside, 'passwd'), path.join(root, 'escape-file'));
  symlinkSync(path.join(root, 'src'), path.join(root, 'inner-link'));
  symlinkSync(path.join(root, '.git'), path.join(root, 'git-link'));
  guard = new PathGuard({ root, ignorePatterns: parseIgnoreFile('# local\n\nsecrets/\n*.log\n') });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function code(input: string): string {
  const r = guard.resolve(input);
  return r.ok ? 'ok' : r.code;
}

describe('PathGuard', () => {
  it('resolves workspace-relative paths, including new files', () => {
    const r = guard.resolve('src/flask/cli.py');
    expect(r).toEqual({
      ok: true,
      absolute: path.join(root, 'src', 'flask', 'cli.py'),
      relative: 'src/flask/cli.py',
    });
    expect(guard.resolve('./docs/new/config.rst')).toMatchObject({
      ok: true,
      relative: 'docs/new/config.rst',
    });
    expect(guard.resolve('src/../docs/cli.rst')).toMatchObject({
      ok: true,
      relative: 'docs/cli.rst',
    });
    expect(guard.resolve('src\\flask\\cli.py')).toMatchObject({
      ok: true,
      relative: 'src/flask/cli.py',
    });
  });

  it('allows absolute paths that are inside the workspace', () => {
    expect(guard.resolve(path.join(root, 'src', 'flask', 'cli.py'))).toMatchObject({ ok: true });
  });

  it('rejects traversal attempts', () => {
    for (const input of [
      '../secret-place/passwd',
      '../../etc/passwd',
      'src/../../secret-place/passwd',
      'src/flask/../../../x',
      '..\\..\\Windows\\win.ini',
      '..',
    ]) {
      expect(code(input), input).toBe('outside_workspace');
    }
  });

  it('rejects absolute paths outside the workspace with a clear message', () => {
    const r = guard.resolve('/etc/passwd');
    expect(r).toMatchObject({ ok: false, code: 'outside_workspace' });
    if (!r.ok) expect(r.message).toMatch(/relative to the workspace root/);
    expect(code(path.join(outside, 'passwd'))).toBe('outside_workspace');
  });

  it('rejects symlinks that escape the workspace, for existing and new files', () => {
    expect(code('escape-file')).toBe('symlink_escape');
    expect(code('escape-dir/passwd')).toBe('symlink_escape');
    expect(code('escape-dir/new-file.txt')).toBe('symlink_escape');
  });

  it('allows symlinks that stay inside, but not into ignored folders', () => {
    expect(code('inner-link/flask/cli.py')).toBe('ok');
    expect(code('git-link/config')).toBe('ignored');
  });

  it('rejects ignored paths: VCS data, dependencies, secrets and build output', () => {
    for (const input of [
      '.git/config',
      '.git',
      'node_modules/flask/index.js',
      'web/node_modules/x.js',
      '.env',
      '.env.local',
      'config/server.pem',
      'deploy/id_rsa',
      'certs/private.key',
      'dist/extension.js',
      'out/test.js',
      'build/lib/flask/cli.py',
      '.venv/bin/python',
      '.swage/state.json',
      'data/app.sqlite',
      'src/flask/__pycache__/cli.cpython-313.pyc',
    ]) {
      expect(code(input), input).toBe('ignored');
    }
    expect(code('.env.example')).toBe('ok');
  });

  it('applies .swageignore patterns', () => {
    expect(code('secrets/token.txt')).toBe('ignored');
    expect(code('logs/app.log')).toBe('ignored');
    expect(code('logs/app.txt')).toBe('ok');
  });

  it('rejects empty and malformed input', () => {
    expect(code('')).toBe('invalid_path');
    expect(code('   ')).toBe('invalid_path');
    expect(code('src/\0cli.py')).toBe('invalid_path');
  });

  it('treats the root itself as inside and not ignored', () => {
    expect(guard.resolve('.')).toMatchObject({ ok: true, relative: '' });
    expect(guard.isIgnored('')).toBe(false);
  });

  it('works with an injected realpath', () => {
    const fake = new PathGuard({
      root: '/ws',
      realpath: (p) => (p === '/ws' ? '/ws' : p === '/ws/link' ? '/elsewhere' : undefined),
    });
    expect(fake.resolve('link/file').ok).toBe(false);
    expect(fake.resolve('a/b').ok).toBe(true);
    const noRoot = new PathGuard({ root: '/nowhere', realpath: () => undefined });
    expect(noRoot.resolve('a.txt')).toMatchObject({ ok: true, relative: 'a.txt' });
  });

  it('parses .swageignore content', () => {
    expect(parseIgnoreFile('# c\n\n  a/ \r\n*.tmp\n')).toEqual(['a/', '*.tmp']);
    expect(DEFAULT_IGNORES).toContain('.git/');
  });
});
