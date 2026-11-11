import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Bm25Searcher, documentedStem, testedStem } from '../../../src/context/bm25';
import { WorkspaceIndex, type IndexFs } from '../../../src/context/indexer';
import { createParser, type CodeParser } from '../../../src/context/symbols';

const FIXTURE = path.join(__dirname, '..', '..', 'retrieval-eval', 'fixture');

let parser: CodeParser;
let index: WorkspaceIndex;
let searcher: Bm25Searcher;

beforeAll(async () => {
  parser = await createParser();
  index = new WorkspaceIndex({ root: FIXTURE, parser, cache: null });
  await index.build();
  searcher = new Bm25Searcher(index);
});

function memoryFs(files: Record<string, string>): IndexFs {
  const enc = new TextEncoder();
  const dirs = (rel: string): { name: string; kind: 'file' | 'dir' }[] => {
    const prefix = rel === '' ? '' : `${rel}/`;
    const seen = new Map<string, 'file' | 'dir'>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const [head, ...rest] = p.slice(prefix.length).split('/');
      if (head !== undefined) seen.set(head, rest.length > 0 ? 'dir' : 'file');
    }
    return [...seen].map(([name, kind]) => ({ name, kind }));
  };
  return {
    readDir: (rel) => Promise.resolve(dirs(rel)),
    stat: (rel) =>
      Promise.resolve(rel in files ? { size: files[rel]?.length ?? 0, mtimeMs: 1 } : undefined),
    readFile: (rel) => Promise.resolve(rel in files ? enc.encode(files[rel]) : undefined),
  };
}

describe('Bm25Searcher', () => {
  it('ranks the defining file first and explains why', () => {
    const [top] = searcher.search('slugify task titles into URL slugs');
    expect(top?.path).toBe('taskboard/utils/slugify.py');
    expect(top?.reasons.join(' | ')).toMatch(/defines `slugify`/);
    expect(top?.reasons.join(' | ')).toMatch(/path matches slug/);
    expect(top?.symbols).toContain('slugify');
    expect(top?.lines).toEqual({ start: 7, end: 10 });
    expect(top?.estimatedTokens).toBeGreaterThan(0);
  });

  it('boosts an exact identifier from the query', () => {
    const [top] = searcher.search('change humanize_delta');
    expect(top?.path).toBe('taskboard/utils/dates.py');
    expect(top?.reasons[0]).toBe('defines `humanize_delta`');
  });

  it('adds the paired test file and the docs page for a source hit', () => {
    const hits = searcher.search('command line routes command init-db');
    const byPath = new Map(hits.map((h) => [h.path, h]));
    expect(byPath.get('tests/test_cli.py')?.reasons).toContain('paired test for taskboard/cli.py');
    expect(byPath.get('docs/cli.md')?.reasons).toContain('documents taskboard/cli.py');
  });

  it('spreads one hop through the import graph', () => {
    const hits = searcher.search('format due date label for priority');
    const store = hits.find((h) => h.path === 'web/src/store.ts');
    expect(store?.reasons.some((r) => r.startsWith('imported by web/src/utils/format.ts'))).toBe(
      true,
    );
    const list = hits.find((h) => h.path === 'web/src/components/TaskList.tsx');
    expect(list?.reasons.some((r) => r.startsWith('imports web/src/utils/format.ts'))).toBe(true);
  });

  it('boosts the active file', () => {
    const plain = searcher.search('task priority');
    const target = plain[3]?.path ?? '';
    const boosted = searcher.search('task priority', { activeFile: target });
    const hit = boosted.find((h) => h.path === target);
    expect(hit?.reasons[0]).toBe('active file');
    expect(hit?.score).toBeGreaterThan(plain[3]?.score ?? 0);
  });

  it('respects the limit and returns nothing for a query of stop words', () => {
    expect(searcher.search('task', { limit: 3 })).toHaveLength(3);
    expect(searcher.search('the and of to please')).toEqual([]);
    expect(searcher.search('zzzunknownzzz')).toEqual([]);
  });

  it('is deterministic', () => {
    const q = 'send an email when a task is assigned';
    expect(searcher.search(q)).toEqual(searcher.search(q));
  });

  it('refreshes after the index changes', async () => {
    const files: Record<string, string> = {
      'pkg/alpha.py': 'def alpha():\n    pass\n',
      'pkg/beta.py': 'def beta():\n    pass\n',
    };
    const fs = memoryFs(files);
    const small = new WorkspaceIndex({ root: '/virtual', parser, fs, cache: null });
    await small.build();
    const s = new Bm25Searcher(small, { weights: { path: 0 } });
    expect(s.search('gamma')).toEqual([]);
    files['pkg/gamma.py'] = 'def gamma():\n    """Gamma rays."""\n';
    await small.update('pkg/gamma.py');
    expect(s.search('gamma')[0]?.path).toBe('pkg/gamma.py');
    s.dispose();
    files['pkg/delta.py'] = 'def delta():\n    pass\n';
    await small.update('pkg/delta.py');
    expect(s.search('delta')).toEqual([]);
  });
});

describe('pairing helpers', () => {
  it('maps test files to the stem they cover', () => {
    expect(testedStem('tests/test_cli.py')).toBe('cli');
    expect(testedStem('pkg/cli_test.py')).toBe('cli');
    expect(testedStem('src/api.test.ts')).toBe('api');
    expect(testedStem('src/api.spec.tsx')).toBe('api');
    expect(testedStem('src/api.ts')).toBeUndefined();
  });

  it('maps docs pages to the stem they document', () => {
    expect(documentedStem('docs/cli.rst')).toBe('cli');
    expect(documentedStem('docs/api/Config.md')).toBe('config');
    expect(documentedStem('doc/cli.txt')).toBe('cli');
    expect(documentedStem('README.md')).toBeUndefined();
    expect(documentedStem('src/cli.py')).toBeUndefined();
  });
});
