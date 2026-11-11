import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fileIndexCache,
  nodeIndexFs,
  WorkspaceIndex,
  type IndexCache,
  type WatchEvent,
  type WatcherLike,
} from '../../../src/context/indexer';
import { createParser, regexParser, type CodeParser } from '../../../src/context/symbols';

let parser: CodeParser;
let root: string;

function write(rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function touchLater(rel: string): void {
  const t = new Date(Date.now() + 5000);
  utimesSync(path.join(root, rel), t, t);
}

beforeAll(async () => {
  parser = await createParser();
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-index-')));
  write('.gitignore', 'generated/\n*.log\n');
  write('.swageignore', 'secret-notes/\n');
  write('app/__init__.py', 'from .cli import main\n');
  write(
    'app/cli.py',
    'import json\nfrom .config import load_config\nfrom app.storage import save\n\n\ndef main():\n    """Run the command line."""\n    print(json.dumps(load_config()))\n',
  );
  write(
    'app/config.py',
    'DEFAULT_PORT = 8000\n\n\nclass Config(dict):\n    def mask_secrets(self):\n        pass\n\n\ndef load_config():\n    return Config()\n',
  );
  write('app/storage/__init__.py', 'def save(item):\n    pass\n');
  write('app/storage/.gitignore', 'tmp/\n');
  write('app/storage/tmp/cache.py', 'x = 1\n');
  write('tests/test_cli.py', 'from app.cli import main\n\n\ndef test_main():\n    main()\n');
  write('docs/cli.md', '# Commands\n\nThe `config` command prints the configuration.\n');
  write(
    'web/src/api.ts',
    "import { format } from './utils/format';\nexport function fetchTasks() { return format([]); }\n",
  );
  write('web/src/utils/format.ts', 'export const format = (x: unknown[]) => x;\n');
  write('web/src/index.ts', "export * from './api';\n");
  write('generated/out.py', 'x = 1\n');
  write('build.log', 'log\n');
  write('secret-notes/a.md', 'secret\n');
  write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  write('.env', 'TOKEN=abc\n');
  write('logo.png', Buffer.from([137, 80, 78, 71, 0, 0, 0, 1]));
  write('data.bin.txt', Buffer.from([65, 0, 66, 67]));
  write('big.py', 'x = 1\n'.repeat(100_000));
  symlinkSync(path.join(root, 'app'), path.join(root, 'app-link'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function memoryCache(): IndexCache & { data: string | undefined; saves: number } {
  const c = {
    data: undefined as string | undefined,
    saves: 0,
    load: () => Promise.resolve(c.data),
    save: (d: string) => {
      c.data = d;
      c.saves++;
      return Promise.resolve();
    },
  };
  return c;
}

describe('WorkspaceIndex.build', () => {
  it('indexes text files while honouring .gitignore, .swageignore, defaults, size and binary limits', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    const stats = await index.build();
    expect(index.files().map((f) => f.path)).toEqual([
      '.gitignore',
      '.swageignore',
      'app/__init__.py',
      'app/cli.py',
      'app/config.py',
      'app/storage/.gitignore',
      'app/storage/__init__.py',
      'docs/cli.md',
      'tests/test_cli.py',
      'web/src/api.ts',
      'web/src/index.ts',
      'web/src/utils/format.ts',
    ]);
    expect(stats).toMatchObject({ files: 12, parsed: 12, reused: 0, removed: 0 });
    // big.py, logo.png (extension), data.bin.txt (NUL byte) and the symlink are skipped.
    expect(stats.skipped).toBe(4);
    expect(index.size).toBe(12);
    expect(index.parserEngine).toBe('tree-sitter');
  });

  it('produces per-file records with language, symbols, imports and tokens', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    const config = index.get('app/config.py');
    expect(config).toMatchObject({
      language: 'python',
      size: expect.any(Number),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(config?.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'constant:DEFAULT_PORT',
      'class:Config',
      'method:mask_secrets',
      'function:load_config',
    ]);
    expect(config?.tokens).toMatchObject({ config: 3, mask: 1, secret: 1 });
    expect(config?.tokenCount).toBeGreaterThan(5);
    expect(config?.estimatedTokens).toBeGreaterThan(10);
    expect(index.get('app/cli.py')?.imports).toEqual(['json', '.config', 'app.storage']);
    expect(index.get('docs/cli.md')?.language).toBe('markdown');
    expect(index.get(path.join(root, 'web/src/api.ts'))?.language).toBe('typescript');
    expect(await index.readText('docs/cli.md')).toContain('prints the configuration');
    expect(await index.readText('missing.md')).toBeUndefined();
  });

  it('builds the import graph across relative, absolute and package imports', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    const { forward, reverse } = index.importGraph();
    expect([...(forward.get('app/cli.py') ?? [])].sort()).toEqual([
      'app/config.py',
      'app/storage/__init__.py',
    ]);
    expect([...(forward.get('app/__init__.py') ?? [])]).toEqual(['app/cli.py']);
    expect([...(forward.get('tests/test_cli.py') ?? [])]).toEqual(['app/cli.py']);
    expect([...(forward.get('web/src/api.ts') ?? [])]).toEqual(['web/src/utils/format.ts']);
    expect([...(forward.get('web/src/index.ts') ?? [])]).toEqual(['web/src/api.ts']);
    expect([...(reverse.get('app/cli.py') ?? [])].sort()).toEqual([
      'app/__init__.py',
      'tests/test_cli.py',
    ]);
    expect(index.importGraph()).toBe(index.importGraph());
  });

  it('rebuilds incrementally from memory and reparses only changed files', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    write('app/config.py', 'def load_config():\n    return {}\n');
    touchLater('app/config.py');
    rmSync(path.join(root, 'docs/cli.md'));
    const stats = await index.build();
    expect(stats).toMatchObject({ parsed: 1, reused: 10, removed: 1, files: 11 });
    expect(index.get('app/config.py')?.symbols.map((s) => s.name)).toEqual(['load_config']);
  });

  it('caches to .swage/index with a .gitignore that hides the folder from git', async () => {
    const first = new WorkspaceIndex({ root, parser });
    await first.build();
    const cacheFile = path.join(root, '.swage', 'index', 'index.json');
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({
      version: 1,
      engine: 'tree-sitter',
    });
    expect(readFileSync(path.join(root, '.swage', '.gitignore'), 'utf8')).toBe('*\n');

    const second = new WorkspaceIndex({ root, parser });
    const stats = await second.build();
    expect(stats).toMatchObject({ parsed: 0, reused: 12 });
    // The cache folder itself is never indexed.
    expect(second.files().some((f) => f.path.startsWith('.swage/'))).toBe(false);
  });

  it('ignores a cache from another engine, version or a corrupt file', async () => {
    const cache = memoryCache();
    await new WorkspaceIndex({ root, parser: regexParser, cache }).build();
    expect((await new WorkspaceIndex({ root, parser, cache }).build()).reused).toBe(0);
    cache.data = '{not json';
    expect((await new WorkspaceIndex({ root, parser, cache }).build()).reused).toBe(0);
    cache.data = JSON.stringify({ version: 99, engine: 'tree-sitter', files: [] });
    expect((await new WorkspaceIndex({ root, parser, cache }).build()).reused).toBe(0);
  });

  it('saves only when something changed', async () => {
    const cache = memoryCache();
    const index = new WorkspaceIndex({ root, parser, cache });
    await index.build();
    await index.build();
    expect(cache.saves).toBe(1);
    await index.save();
    expect(cache.saves).toBe(1);
  });

  it('applies extra ignore patterns from the swage.ignore setting', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null, ignorePatterns: ['web/'] });
    await index.build();
    expect(index.files().some((f) => f.path.startsWith('web/'))).toBe(false);
  });

  it('respects a custom size limit', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null, maxFileBytes: 100 });
    await index.build();
    expect(index.get('app/cli.py')).toBeUndefined();
    expect(index.get('app/__init__.py')).toBeDefined();
  });
});

describe('watcher hook', () => {
  class FakeWatcher implements WatcherLike {
    private listener: ((e: WatchEvent) => void) | undefined;
    onEvent(listener: (e: WatchEvent) => void): { dispose(): void } {
      this.listener = listener;
      return { dispose: () => (this.listener = undefined) };
    }
    fire(e: WatchEvent): void {
      this.listener?.(e);
    }
  }

  it('updates, adds and removes records from file events', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    const watcher = new FakeWatcher();
    const sub = index.attachWatcher(watcher);
    const seen: string[] = [];
    const listen = index.onDidUpdate((paths) => seen.push(...paths));

    write('app/routes.py', 'def list_routes():\n    pass\n');
    watcher.fire({ type: 'create', path: path.join(root, 'app/routes.py') });
    write('app/config.py', 'def load_settings():\n    pass\n');
    watcher.fire({ type: 'change', path: 'app/config.py' });
    rmSync(path.join(root, 'docs'), { recursive: true });
    watcher.fire({ type: 'delete', path: 'docs' });
    await index.idle();

    expect(index.get('app/routes.py')?.symbols.map((s) => s.name)).toEqual(['list_routes']);
    expect(index.get('app/config.py')?.symbols.map((s) => s.name)).toEqual(['load_settings']);
    expect(index.get('docs/cli.md')).toBeUndefined();
    expect(seen).toEqual(['app/routes.py', 'app/config.py', 'docs/cli.md']);

    // Ignored and generated files never enter the index.
    write('generated/new.py', 'x = 1\n');
    watcher.fire({ type: 'create', path: 'generated/new.py' });
    write('app/storage/tmp/new.py', 'x = 1\n');
    watcher.fire({ type: 'create', path: 'app/storage/tmp/new.py' });
    write('node_modules/x/y.js', '1');
    watcher.fire({ type: 'change', path: 'node_modules/x/y.js' });
    await index.idle();
    expect(index.get('generated/new.py')).toBeUndefined();
    expect(index.get('app/storage/tmp/new.py')).toBeUndefined();
    expect(index.get('node_modules/x/y.js')).toBeUndefined();

    sub.dispose();
    listen.dispose();
    watcher.fire({ type: 'delete', path: 'app/routes.py' });
    await index.idle();
    expect(index.get('app/routes.py')).toBeDefined();
  });

  it('rebuilds when an ignore file changes', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    write('.swageignore', 'web/\n');
    await index.handleEvent({ type: 'change', path: '.swageignore' });
    expect(index.files().some((f) => f.path.startsWith('web/'))).toBe(false);
    rmSync(path.join(root, '.swageignore'));
    await index.handleEvent({ type: 'delete', path: '.swageignore' });
    expect(index.get('web/src/api.ts')).toBeDefined();
  });

  it('removes a file that becomes binary or disappears on update', async () => {
    const index = new WorkspaceIndex({ root, parser, cache: null });
    await index.build();
    write('docs/cli.md', Buffer.from([0, 1, 2]));
    await index.update('docs/cli.md');
    expect(index.get('docs/cli.md')).toBeUndefined();
    rmSync(path.join(root, 'app/cli.py'));
    await index.update('app/cli.py');
    expect(index.get('app/cli.py')).toBeUndefined();
    index.remove('not-indexed.py');
  });
});

describe('node adapters', () => {
  it('reports missing paths as undefined or empty', async () => {
    const fs = nodeIndexFs(root);
    expect(await fs.readDir('nope')).toEqual([]);
    expect(await fs.stat('nope')).toBeUndefined();
    expect(await fs.stat('app')).toBeUndefined();
    expect(await fs.readFile('nope')).toBeUndefined();
    expect(await fileIndexCache(root, 'other').load()).toBeUndefined();
  });
});
