import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Resolves agent-supplied paths inside the workspace only (blueprint section 6, rule 2).
 * Rejects traversal, absolute paths outside the root, symlinks that escape it, and
 * ignored paths such as `.git`, `node_modules`, secrets and build output.
 */

/** Always ignored, whatever `.swageignore` says. Gitignore syntax. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.aws/',
  '.ssh/',
  'dist/',
  'out/',
  'build/',
  'coverage/',
  '.vscode-test/',
  '*.vsix',
  '.swage/',
  '.trueforge/',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
];

export type PathGuardErrorCode =
  'invalid_path' | 'outside_workspace' | 'symlink_escape' | 'ignored';

export type PathResult =
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | {
      readonly ok: false;
      readonly code: PathGuardErrorCode;
      readonly path: string;
      readonly message: string;
    };

export interface PathGuardOptions {
  /** Absolute path of the workspace folder. */
  readonly root: string;
  /** Extra gitignore-style patterns, from `.swageignore` and the `swage.ignore` setting. */
  readonly ignorePatterns?: readonly string[];
  /** Real path of an existing file or folder, or `undefined` if it does not exist. Injected for tests. */
  readonly realpath?: (p: string) => string | undefined;
}

function defaultRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** Parses `.swageignore` content: one gitignore pattern per line, `#` comments allowed. */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PathGuard {
  private readonly root: string;
  private readonly realRoot: string;
  private readonly realpath: (p: string) => string | undefined;
  private readonly matcher: Ignore;

  constructor(options: PathGuardOptions) {
    this.root = path.resolve(options.root);
    this.realpath = options.realpath ?? defaultRealpath;
    this.realRoot = this.realpath(this.root) ?? this.root;
    this.matcher = ignore()
      .add([...DEFAULT_IGNORES])
      .add([...(options.ignorePatterns ?? [])]);
  }

  /** True when a workspace-relative POSIX path matches an ignore rule. */
  isIgnored(relative: string): boolean {
    if (relative === '' || relative === '.') return false;
    // Folder rules such as `.git/` only match a path that looks like a folder, so check both forms.
    return this.matcher.ignores(relative) || this.matcher.ignores(`${relative}/`);
  }

  resolve(input: string): PathResult {
    const fail = (code: PathGuardErrorCode, message: string): PathResult => ({
      ok: false,
      code,
      path: input,
      message,
    });

    if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
      return fail('invalid_path', 'Give a non-empty workspace-relative path.');
    }

    const normalized = input.replace(/\\/g, '/');
    const absolute = path.resolve(this.root, normalized);
    if (!isInside(this.root, absolute)) {
      return fail(
        'outside_workspace',
        path.isAbsolute(normalized)
          ? `${input} is outside the workspace. Use a path relative to the workspace root.`
          : `${input} leaves the workspace. Paths must stay inside the workspace root.`,
      );
    }

    const real = this.resolveReal(absolute);
    if (!isInside(this.realRoot, real)) {
      return fail(
        'symlink_escape',
        `${input} resolves through a symlink to a location outside the workspace.`,
      );
    }

    const relative = toPosix(path.relative(this.root, absolute));
    const realRelative = toPosix(path.relative(this.realRoot, real));
    if (this.isIgnored(relative) || this.isIgnored(realRelative)) {
      return fail(
        'ignored',
        `${input} is excluded by Swage's ignore rules (secrets, VCS data, dependencies or build output).`,
      );
    }
    return { ok: true, absolute, relative };
  }

  /** Real path of `absolute`, following symlinks of its deepest existing ancestor. */
  private resolveReal(absolute: string): string {
    const missing: string[] = [];
    let current = absolute;
    for (;;) {
      const real = this.realpath(current);
      if (real !== undefined) return path.join(real, ...missing.reverse());
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
