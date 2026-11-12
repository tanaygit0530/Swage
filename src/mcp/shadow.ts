import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ChangeSet } from '../changeset/changeSet';
import { redactText } from '../safety/redact';
import type { PathGuard } from '../safety/pathGuard';

/**
 * Shadow copies for run_tests and run_command (blueprint sections 6 and 8). Commands never
 * run in the workspace: they run in a temporary copy with the staged edits applied, without a
 * shell, with a scrubbed environment, a timeout and capped output. The copy is snapshotted
 * before and after, so every file a command touched is reported. Nothing is copied back.
 */

export interface Shadow {
  readonly dir: string;
  /** Staged files written into the copy. */
  readonly overlaid: readonly string[];
  dispose(): Promise<void>;
}

export interface FileChanges {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

/** Folders that are never copied or tracked, besides the path guard's ignore rules. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache']);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Files git tracks in the workspace (empty when it is not a git repository). A tracked file is
 * already in the repository, so a test fixture such as Flask's tests/test_apps/.env is copied
 * into the shadow even though the path guard hides `.env` files from the agent; an untracked
 * `.env` (where real secrets live) is still left out.
 */
export function trackedFiles(root: string): { files: Set<string>; dirs: Set<string> } {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const files = new Set(r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs };
}

/** Copies the workspace (skipping ignored paths and symlinks) and applies the staged overlay. */
export async function createShadow(
  root: string,
  guard: PathGuard,
  changeSet?: ChangeSet,
): Promise<Shadow> {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'swage-shadow-'));
  const tracked = trackedFiles(root);
  const copy = async (rel: string): Promise<void> => {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      // Symlinks are skipped: a link could let a command write back into the real workspace.
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      // Virtual environments are not copied: test commands use the real one (prepareCommand).
      if (e.isDirectory() && existsSync(path.join(root, childRel, 'pyvenv.cfg'))) continue;
      if (
        guard.isIgnored(childRel) &&
        !(e.isFile() ? tracked.files.has(childRel) : tracked.dirs.has(childRel))
      )
        continue;
      if (e.isDirectory()) {
        await fsp.mkdir(path.join(dir, childRel), { recursive: true });
        await copy(childRel);
      } else if (e.isFile()) {
        await fsp.copyFile(path.join(root, childRel), path.join(dir, childRel));
      }
    }
  };
  await copy('');

  const overlaid: string[] = [];
  for (const p of changeSet?.stagedPaths() ?? []) {
    const staged = changeSet?.staged(p);
    if (!staged) continue;
    const target = path.join(dir, p);
    if (staged.deleted) {
      await fsp.rm(target, { force: true });
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, staged.content);
    }
    overlaid.push(p);
  }
  return { dir, overlaid, dispose: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** Content hashes of every regular file in a folder (skipping caches and symlinks). */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile()) {
        out.set(
          toPosix(childRel),
          createHash('sha256')
            .update(await fsp.readFile(path.join(dir, childRel)))
            .digest('hex'),
        );
      }
    }
  };
  await walk('');
  return out;
}

export function diffSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): FileChanges {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, h] of after) {
    const old = before.get(p);
    if (old === undefined) created.push(p);
    else if (old !== h) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/** Environment variables passed to commands; everything else (including any key or token) is dropped. */
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
];

export function scrubbedEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  return {
    ...env,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    ...extra,
  };
}

/** Virtual environments a Python project usually keeps at its root. */
const VENV_DIRS = ['.venv', 'venv', 'env'];

/** `<root>/.venv/bin/<program>` (or Scripts\\<program>.exe on Windows) when it exists. */
export function venvProgram(root: string, program: string): string | undefined {
  if (!/^(pytest|py\.test|python|python3(\.\d+)?)$/.test(program)) return undefined;
  for (const dir of VENV_DIRS) {
    const candidate =
      process.platform === 'win32'
        ? path.join(root, dir, 'Scripts', `${program}.exe`)
        : path.join(root, dir, 'bin', program);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Prepares argv and env for a test command in the shadow: a relative program path such as
 * `.venv/bin/python` resolves against the real workspace (virtualenvs are not copied), Python
 * gets the shadow's `src` (or root) first on PYTHONPATH so staged code is imported (spike S10),
 * and pytest runs without its cache.
 */
export function prepareCommand(
  argv: readonly string[],
  root: string,
  shadowDir: string,
  runner?: string,
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const out = [...argv];
  const program = out[0] ?? '';
  if (program.includes('/') && !path.isAbsolute(program)) {
    const real = path.join(root, program);
    if (!existsSync(path.join(shadowDir, program)) && existsSync(real)) out[0] = real;
  } else if (!program.includes('/') && !program.includes('\\')) {
    // A bare `pytest` or `python` uses the workspace's virtual environment when it has one, so
    // tests run with the project's dependencies, not whatever is first on the PATH.
    const local = venvProgram(root, program);
    if (local) out[0] = local;
  }
  if (runner === 'pytest') out.push('-p', 'no:cacheprovider');
  const src = path.join(shadowDir, 'src');
  const pythonPath = [existsSync(src) ? src : undefined, shadowDir]
    .filter((p): p is string => p !== undefined)
    .join(path.delimiter);
  return { argv: out, env: scrubbedEnv({ PYTHONPATH: pythonPath }) };
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Redacted combined output, at most `maxOutputBytes` (the tail is kept). */
  readonly output: string;
  readonly droppedBytes: number;
  readonly ms: number;
  readonly pid: number | undefined;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Runs argv without a shell; kills the whole process tree on timeout or abort. */
export function runProcess(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = options.maxOutputBytes ?? 64 * 1024;
  const grace = options.killGraceMs ?? 2000;
  return new Promise((resolve) => {
    let output = '';
    let dropped = 0;
    let timedOut = false;
    let cancelled = false;
    const [program = '', ...args] = argv;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > max) {
        dropped += output.length - max;
        output = output.slice(output.length - max);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const stop = (): void => {
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), grace).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, extra = ''): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        output: redactText(output + extra),
        droppedBytes: dropped,
        ms: Date.now() - started,
        pid: child.pid,
      });
    };
    child.on('error', (err) => finish(null, null, `\n${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function describeChanges(changes: FileChanges): string {
  const parts = [
    ...changes.created.map((p) => `+ ${p} (created)`),
    ...changes.modified.map((p) => `~ ${p} (modified)`),
    ...changes.deleted.map((p) => `- ${p} (deleted)`),
  ];
  return parts.length === 0
    ? 'The command did not change any files in the copy.'
    : parts.join('\n');
}
