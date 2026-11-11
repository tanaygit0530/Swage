import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { parseIgnoreFile, PathGuard } from '../safety/pathGuard';
import { grammarOf, type CodeParser, type CodeSymbol } from './symbols';
import { estimateTokens, termFrequencies } from './tokens';

/**
 * Workspace index for lexical retrieval (blueprint section 7). Walks the workspace while
 * honouring nested `.gitignore` files, `.swageignore` and the path guard's default ignores,
 * skips binaries, symlinks and files over 512 KB, and keeps one record per file. Builds
 * are incremental (size and mtime) and cached on disk; a watcher hook keeps it fresh.
 */

export const MAX_FILE_BYTES = 512 * 1024;
export const INDEX_VERSION = 1;

export interface FileRecord {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string;
  /** Grammar for code files, otherwise a coarse kind such as `markdown` or `text`. */
  readonly language: string;
  readonly symbols: readonly CodeSymbol[];
  /** Import specifiers as written. */
  readonly imports: readonly string[];
  /** Term frequencies of identifier tokens in the content. */
  readonly tokens: Readonly<Record<string, number>>;
  /** Number of tokens, the BM25 document length. */
  readonly tokenCount: number;
  /** Estimated model tokens to read the whole file. */
  readonly estimatedTokens: number;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'symlink' | 'other';
}

/** File access relative to the workspace root, injectable for tests. */
export interface IndexFs {
  readDir(rel: string): Promise<DirEntry[]>;
  stat(rel: string): Promise<{ size: number; mtimeMs: number } | undefined>;
  readFile(rel: string): Promise<Uint8Array | undefined>;
}

export interface IndexCache {
  load(): Promise<string | undefined>;
  save(data: string): Promise<void>;
}

export interface WatchEvent {
  readonly type: 'create' | 'change' | 'delete';
  /** Workspace-relative or absolute path. */
  readonly path: string;
}

/** Anything that can push file events, for example an adapter over a VS Code FileSystemWatcher. */
export interface WatcherLike {
  onEvent(listener: (event: WatchEvent) => void): { dispose(): void };
}

export interface BuildStats {
  readonly files: number;
  readonly parsed: number;
  readonly reused: number;
  readonly removed: number;
  readonly skipped: number;
  readonly ms: number;
}

export interface IndexerOptions {
  readonly root: string;
  readonly parser: CodeParser;
  readonly fs?: IndexFs;
  /** Defaults to `<root>/.swage/index/index.json`; pass `null` for no cache. */
  readonly cache?: IndexCache | null;
  /** Extra ignore patterns, for example from the `swage.ignore` setting. */
  readonly ignorePatterns?: readonly string[];
  readonly maxFileBytes?: number;
}

/** Code-point order, independent of the machine's locale. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const BINARY_EXT = new Set(
  'png jpg jpeg gif bmp ico icns webp avif tiff psd pdf zip gz tgz bz2 xz 7z rar jar war whl egg wasm so dylib dll exe bin o a lib class pyc pyo mo woff woff2 ttf otf eot mp3 mp4 m4a wav ogg flac mov avi mkv webm sqlite sqlite3 db pkl npy npz parquet'.split(
    ' ',
  ),
);

const TEXT_KIND: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  rst: 'rst',
  txt: 'text',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  cfg: 'ini',
  ini: 'ini',
  html: 'html',
  css: 'css',
  sh: 'shell',
};

function extOf(p: string): string {
  return /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Node implementation of IndexFs rooted at `root`. */
export function nodeIndexFs(root: string): IndexFs {
  const abs = (rel: string): string => path.join(root, rel);
  return {
    async readDir(rel) {
      const entries = await fsp.readdir(abs(rel), { withFileTypes: true }).catch(() => []);
      return entries.map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink()
          ? 'symlink'
          : e.isDirectory()
            ? 'dir'
            : e.isFile()
              ? 'file'
              : 'other',
      }));
    },
    async stat(rel) {
      const s = await fsp.stat(abs(rel)).catch(() => undefined);
      return s?.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
    },
    async readFile(rel) {
      return fsp.readFile(abs(rel)).catch(() => undefined);
    },
  };
}

/**
 * Cache file under `<root>/.swage/index/`. It also writes `.swage/.gitignore` containing
 * `*`, so git ignores the whole folder and `git status` stays clean (blueprint section 8).
 */
export function fileIndexCache(root: string, dir = path.join('.swage', 'index')): IndexCache {
  const file = path.join(root, dir, 'index.json');
  const swageDir = path.join(root, '.swage');
  return {
    async load() {
      return fsp.readFile(file, 'utf8').catch(() => undefined);
    },
    async save(data) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(path.join(swageDir, '.gitignore'), '*\n');
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    },
  };
}

interface GitignoreLayer {
  readonly base: string;
  readonly matcher: Ignore;
}

export class WorkspaceIndex {
  readonly root: string;
  private readonly parser: CodeParser;
  private readonly fs: IndexFs;
  private readonly cache: IndexCache | null;
  private readonly extraIgnores: readonly string[];
  private readonly maxFileBytes: number;
  private guard: PathGuard;
  private readonly records = new Map<string, FileRecord>();
  private graphCache:
    { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(paths: readonly string[]) => void>();
  private dirty = false;

  constructor(options: IndexerOptions) {
    this.root = path.resolve(options.root);
    this.parser = options.parser;
    this.fs = options.fs ?? nodeIndexFs(this.root);
    this.cache = options.cache === undefined ? fileIndexCache(this.root) : options.cache;
    this.extraIgnores = options.ignorePatterns ?? [];
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.guard = new PathGuard({ root: this.root, ignorePatterns: this.extraIgnores });
  }

  get size(): number {
    return this.records.size;
  }

  get parserEngine(): CodeParser['engine'] {
    return this.parser.engine;
  }

  files(): FileRecord[] {
    return [...this.records.values()].sort((a, b) => comparePaths(a.path, b.path));
  }

  get(rel: string): FileRecord | undefined {
    return this.records.get(this.toRel(rel));
  }

  /** Reads a file's current text through the index file system. */
  async readText(rel: string): Promise<string | undefined> {
    const bytes = await this.fs.readFile(this.toRel(rel));
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  /** Called with the changed paths after a build or a watcher update. */
  onDidUpdate(listener: (paths: readonly string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private toRel(p: string): string {
    const rel = path.isAbsolute(p) ? path.relative(this.root, p) : p;
    return rel.split(path.sep).join('/').replace(/^\.\//, '');
  }

  private async loadSwageIgnore(): Promise<void> {
    const bytes = await this.fs.readFile('.swageignore');
    const patterns = bytes ? parseIgnoreFile(new TextDecoder().decode(bytes)) : [];
    this.guard = new PathGuard({
      root: this.root,
      ignorePatterns: [...this.extraIgnores, ...patterns],
    });
  }

  private async gitignoreLayer(dirRel: string): Promise<GitignoreLayer | undefined> {
    const bytes = await this.fs.readFile(dirRel === '' ? '.gitignore' : `${dirRel}/.gitignore`);
    if (!bytes) return undefined;
    return {
      base: dirRel,
      matcher: ignore().add(parseIgnoreFile(new TextDecoder().decode(bytes))),
    };
  }

  private ignoredBy(layers: readonly GitignoreLayer[], rel: string, isDir: boolean): boolean {
    if (this.guard.isIgnored(rel)) return true;
    for (const layer of layers) {
      if (layer.base !== '' && !rel.startsWith(`${layer.base}/`)) continue;
      const sub = layer.base === '' ? rel : rel.slice(layer.base.length + 1);
      if (layer.matcher.ignores(isDir ? `${sub}/` : sub)) return true;
    }
    return false;
  }

  /** Gitignore layers that apply to a path, for single-file updates. */
  private async layersFor(rel: string): Promise<GitignoreLayer[]> {
    const layers: GitignoreLayer[] = [];
    const parts = rel.split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const layer = await this.gitignoreLayer(parts.slice(0, i).join('/'));
      if (layer) layers.push(layer);
    }
    return layers;
  }

  private async walk(
    dirRel: string,
    layers: readonly GitignoreLayer[],
    out: string[],
  ): Promise<number> {
    const own = await this.gitignoreLayer(dirRel);
    const active = own ? [...layers, own] : layers;
    let skipped = 0;
    const entries = await this.fs.readDir(dirRel);
    entries.sort((a, b) => comparePaths(a.name, b.name));
    for (const entry of entries) {
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.kind === 'symlink' || entry.kind === 'other') {
        skipped++;
        continue;
      }
      if (this.ignoredBy(active, rel, entry.kind === 'dir')) continue;
      if (entry.kind === 'dir') skipped += await this.walk(rel, active, out);
      else out.push(rel);
    }
    return skipped;
  }

  private async loadCache(): Promise<Map<string, FileRecord>> {
    const raw = this.cache ? await this.cache.load() : undefined;
    if (raw === undefined) return new Map();
    try {
      const data = JSON.parse(raw) as { version?: number; engine?: string; files?: FileRecord[] };
      if (
        data.version !== INDEX_VERSION ||
        data.engine !== this.parser.engine ||
        !Array.isArray(data.files)
      ) {
        return new Map();
      }
      return new Map(data.files.map((f) => [f.path, f]));
    } catch {
      return new Map();
    }
  }

  /** Saves the index to the cache if anything changed since the last save. */
  async save(): Promise<void> {
    if (!this.cache || !this.dirty) return;
    this.dirty = false;
    await this.cache.save(
      JSON.stringify({ version: INDEX_VERSION, engine: this.parser.engine, files: this.files() }),
    );
  }

  /** Full incremental build: reuses unchanged records from memory or the cache. */
  async build(): Promise<BuildStats> {
    const started = performance.now();
    await this.loadSwageIgnore();
    const cached = this.records.size > 0 ? new Map(this.records) : await this.loadCache();
    const paths: string[] = [];
    let skipped = await this.walk('', [], paths);
    let parsed = 0;
    let reused = 0;
    const next = new Map<string, FileRecord>();

    for (const rel of paths) {
      const stat = await this.fs.stat(rel);
      if (!stat) continue;
      const prev = cached.get(rel);
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
        next.set(rel, prev);
        reused++;
        continue;
      }
      const record = await this.readRecord(rel, stat);
      if (record) {
        next.set(rel, record);
        parsed++;
      } else {
        skipped++;
      }
    }

    const removed = [...cached.keys()].filter((p) => !next.has(p)).length;
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
    this.graphCache = undefined;
    if (parsed > 0 || removed > 0 || cached.size !== next.size) this.dirty = true;
    await this.save();
    this.emit(paths);
    return { files: next.size, parsed, reused, removed, skipped, ms: performance.now() - started };
  }

  private async readRecord(
    rel: string,
    stat: { size: number; mtimeMs: number },
  ): Promise<FileRecord | undefined> {
    if (stat.size > this.maxFileBytes || BINARY_EXT.has(extOf(rel))) return undefined;
    const bytes = await this.fs.readFile(rel);
    if (!bytes || bytes.length > this.maxFileBytes || looksBinary(bytes)) return undefined;
    const text = new TextDecoder().decode(bytes);
    const grammar = grammarOf(rel);
    const parsed = grammar ? this.parser.parse(text, grammar) : { symbols: [], imports: [] };
    const tf = termFrequencies(text);
    let tokenCount = 0;
    for (const n of tf.values()) tokenCount += n;
    return {
      path: rel,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: createHash('sha256').update(bytes).digest('hex'),
      language: grammar ?? TEXT_KIND[extOf(rel)] ?? 'text',
      symbols: parsed.symbols,
      imports: parsed.imports,
      tokens: Object.fromEntries(tf),
      tokenCount,
      estimatedTokens: estimateTokens(text),
    };
  }

  /** Re-indexes one file, or removes it if it is gone, ignored, binary or too large. */
  async update(p: string): Promise<void> {
    const rel = this.toRel(p);
    if (rel === '.swageignore' || rel.endsWith('.gitignore')) {
      await this.build();
      return;
    }
    const stat = await this.fs.stat(rel);
    const layers = await this.layersFor(rel);
    const parts = rel.split('/');
    const ignored = parts.some((_, i) =>
      this.ignoredBy(layers, parts.slice(0, i + 1).join('/'), i < parts.length - 1),
    );
    const record = stat && !ignored ? await this.readRecord(rel, stat) : undefined;
    if (record) this.records.set(rel, record);
    else this.records.delete(rel);
    this.graphCache = undefined;
    this.dirty = true;
    this.emit([rel]);
  }

  remove(p: string): void {
    const rel = this.toRel(p);
    if (this.records.delete(rel)) {
      this.graphCache = undefined;
      this.dirty = true;
      this.emit([rel]);
    }
  }

  /** Applies one watcher event. Events are processed in order. */
  handleEvent(event: WatchEvent): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (event.type === 'delete') {
        const rel = this.toRel(event.path);
        if (rel === '.swageignore' || rel.endsWith('.gitignore')) await this.build();
        else {
          this.remove(rel);
          // A deleted folder removes every file under it.
          for (const key of [...this.records.keys()])
            if (key.startsWith(`${rel}/`)) this.remove(key);
        }
      } else {
        await this.update(event.path);
      }
    });
    return this.queue;
  }

  /** Subscribes the index to a watcher. Dispose the result to stop. */
  attachWatcher(watcher: WatcherLike): { dispose(): void } {
    return watcher.onEvent((e) => void this.handleEvent(e));
  }

  /** Resolves when every queued watcher event has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private emit(paths: readonly string[]): void {
    for (const l of this.listeners) l(paths);
  }

  /** Import graph between indexed files: forward (imports) and reverse (imported by). */
  importGraph(): {
    forward: ReadonlyMap<string, ReadonlySet<string>>;
    reverse: ReadonlyMap<string, ReadonlySet<string>>;
  } {
    if (this.graphCache) return this.graphCache;
    const forward = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const pyModules = new Map<string, string[]>();
    for (const rec of this.records.values()) {
      if (rec.language !== 'python') continue;
      const mod = rec.path.replace(/\.pyi?$/, '').replace(/\/__init__$/, '');
      const parts = mod.split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('.');
        const list = pyModules.get(key) ?? [];
        list.push(rec.path);
        pyModules.set(key, list);
      }
    }

    for (const rec of this.records.values()) {
      const targets = new Set<string>();
      for (const spec of rec.imports) {
        const target =
          rec.language === 'python'
            ? this.resolvePython(rec.path, spec, pyModules)
            : this.resolveScript(rec.path, spec);
        if (target !== undefined && target !== rec.path) targets.add(target);
      }
      forward.set(rec.path, targets);
      for (const t of targets) {
        const set = reverse.get(t) ?? new Set<string>();
        set.add(rec.path);
        reverse.set(t, set);
      }
    }
    this.graphCache = { forward, reverse };
    return this.graphCache;
  }

  private resolvePython(
    from: string,
    spec: string,
    modules: ReadonlyMap<string, string[]>,
  ): string | undefined {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    if (dots > 0) {
      const dirParts = from.split('/').slice(0, -1);
      const up = dirParts.slice(0, Math.max(0, dirParts.length - (dots - 1)));
      const rest = spec.slice(dots).split('.').filter(Boolean);
      const base = [...up, ...rest].join('/');
      for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`]) {
        if (this.records.has(candidate)) return candidate;
      }
      return undefined;
    }
    const parts = spec.split('.');
    for (let n = parts.length; n > 0; n--) {
      const found = modules.get(parts.slice(0, n).join('.'));
      if (found && found.length > 0) return [...found].sort((a, b) => a.length - b.length)[0];
    }
    return undefined;
  }

  private resolveScript(from: string, spec: string): string | undefined {
    if (!spec.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
    for (const b of [base, stripped]) {
      for (const ext of exts) if (this.records.has(b + ext)) return b + ext;
      for (const ext of exts.slice(1))
        if (this.records.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
    return undefined;
  }
}
