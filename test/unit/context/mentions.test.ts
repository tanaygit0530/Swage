import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex, type IndexFs } from '../../../src/context/indexer';
import {
  fuzzyScore,
  mentionCompletions,
  parseMentions,
  promptCost,
  resolveMentions,
} from '../../../src/context/mentions';
import { createParser } from '../../../src/context/symbols';

const FILES: Record<string, string> = {
  'src/flask/cli.py':
    'import click\n\n\nclass ScriptInfo:\n    def load_app(self):\n        return None\n\n\ndef routes_command():\n    """Show routes."""\n    return 1\n',
  'src/flask/helpers.py': 'def get_debug_flag():\n    return False\n',
  'tests/test_cli.py':
    'from flask.cli import routes_command\n\n\ndef test_routes():\n    assert routes_command() == 1\n',
  'docs/cli.rst': 'Command line\n============\n',
  'examples/cli.py': 'def run():\n    pass\n',
  'config/settings.py': `DB_PASSWORD = "${'hunter' + '2-real'}"\nDEBUG = True\n`,
  'big/data.py': 'x = 1\n'.repeat(5000),
};

function memoryFs(files: Record<string, string>): IndexFs {
  const enc = new TextEncoder();
  return {
    readDir: (rel) => {
      const prefix = rel === '' ? '' : `${rel}/`;
      const seen = new Map<string, 'file' | 'dir'>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const [head, ...rest] = p.slice(prefix.length).split('/');
        if (head !== undefined) seen.set(head, rest.length > 0 ? 'dir' : 'file');
      }
      return Promise.resolve([...seen].map(([name, kind]) => ({ name, kind })));
    },
    stat: (rel) =>
      Promise.resolve(rel in files ? { size: files[rel]?.length ?? 0, mtimeMs: 1 } : undefined),
    readFile: (rel) => Promise.resolve(rel in files ? enc.encode(files[rel]) : undefined),
  };
}

let index: WorkspaceIndex;

beforeAll(async () => {
  index = new WorkspaceIndex({
    root: '/ws',
    parser: await createParser(),
    fs: memoryFs(FILES),
    cache: null,
  });
  await index.build();
});

describe('parseMentions', () => {
  it('finds file and symbol mentions with positions', () => {
    const prompt = 'Use @src/flask/cli.py and @routes_command, then @ScriptInfo.load_app.';
    expect(parseMentions(prompt)).toEqual([
      {
        raw: '@src/flask/cli.py',
        kind: 'file',
        explicit: false,
        target: 'src/flask/cli.py',
        start: 4,
        end: 21,
      },
      {
        raw: '@routes_command',
        kind: 'symbol',
        explicit: false,
        target: 'routes_command',
        start: 26,
        end: 41,
      },
      {
        raw: '@ScriptInfo.load_app',
        kind: 'symbol',
        explicit: false,
        target: 'ScriptInfo.load_app',
        start: 48,
        end: 68,
      },
    ]);
  });

  it('supports explicit prefixes, punctuation and brackets, and ignores emails', () => {
    const m = parseMentions(
      '(@file:docs/cli.rst), @symbol:get_debug_flag; mail me@example.com "@cli.py"',
    );
    expect(m.map((x) => [x.raw, x.kind, x.explicit])).toEqual([
      ['@file:docs/cli.rst', 'file', true],
      ['@symbol:get_debug_flag', 'symbol', true],
      ['@cli.py', 'file', false],
    ]);
    expect(parseMentions('@ alone and @')).toEqual([]);
    expect(parseMentions('@src\\flask\\cli.py')[0]?.target).toBe('src/flask/cli.py');
  });
});

describe('completions', () => {
  it('scores subsequences, rewarding segment starts and suffixes', () => {
    expect(fuzzyScore('cli', 'src/flask/cli.py')).toBeGreaterThan(
      fuzzyScore('cli', 'src/flask/click_helpers.py'),
    );
    expect(fuzzyScore('xyz', 'src/flask/cli.py')).toBe(0);
    expect(fuzzyScore('', 'anything')).toBe(1);
    expect(fuzzyScore('gdf', 'get_debug_flag')).toBeGreaterThan(0);
  });

  it('offers files and symbols for what follows @', () => {
    const files = mentionCompletions(index, '@flask/cli');
    expect(files[0]).toMatchObject({
      kind: 'file',
      label: 'src/flask/cli.py',
      insertText: '@src/flask/cli.py',
    });
    const syms = mentionCompletions(index, 'routes_com');
    expect(syms[0]).toMatchObject({
      kind: 'symbol',
      label: 'routes_command',
      detail: 'function in src/flask/cli.py:9',
    });
    expect(mentionCompletions(index, '@symbol:load_app')[0]).toMatchObject({
      label: 'ScriptInfo.load_app',
    });
    expect(mentionCompletions(index, '', 3)).toHaveLength(3);
  });
});

describe('resolveMentions', () => {
  it('attaches files and symbols and reports exactly what was attached and what it cost', async () => {
    const r = await resolveMentions('Fix @tests/test_cli.py and @routes_command', index);
    expect(r.attachments).toHaveLength(2);
    const [file, sym] = r.attachments;
    expect(file).toMatchObject({
      kind: 'file',
      path: 'tests/test_cli.py',
      startLine: 1,
      endLine: 5,
      truncated: false,
    });
    expect(file?.content).toBe(FILES['tests/test_cli.py']);
    expect(sym).toMatchObject({
      kind: 'symbol',
      path: 'src/flask/cli.py',
      symbol: 'routes_command',
      startLine: 9,
      endLine: 11,
    });
    expect(sym?.content).toBe('def routes_command():\n    """Show routes."""\n    return 1\n');
    expect(sym?.callers).toEqual([
      { path: 'tests/test_cli.py', line: 1 },
      { path: 'tests/test_cli.py', line: 5 },
    ]);
    expect(r.totalTokens).toBe((file?.tokens ?? 0) + (sym?.tokens ?? 0));
    expect(r.report).toContain(
      `Attached @tests/test_cli.py: tests/test_cli.py (${file?.tokens} tokens)`,
    );
    expect(r.report).toContain('Attached @routes_command: routes_command in src/flask/cli.py:9-11');
    expect(r.report).toContain('2 caller(s) listed');
    expect(r.report).toMatch(/Mentions total: \d+ of 8,000 tokens/);
    expect(promptCost('Fix it', r)).toBe(r.totalTokens + 2);
  });

  it('resolves a unique file suffix, a qualified method and explicit kinds', async () => {
    const r = await resolveMentions('@helpers.py @ScriptInfo.load_app @file:docs/cli.rst', index);
    expect(r.attachments.map((a) => a.path)).toEqual([
      'src/flask/helpers.py',
      'src/flask/cli.py',
      'docs/cli.rst',
    ]);
    expect(r.attachments[1]?.symbol).toBe('ScriptInfo.load_app');
  });

  it('reports ambiguous and unknown mentions with suggestions', async () => {
    const r = await resolveMentions('@cli.py @routes_comand @symbol:docs', index);
    expect(r.attachments).toEqual([]);
    expect(r.unresolved[0]).toMatchObject({
      mention: '@cli.py',
      message: expect.stringMatching(/several files/),
    });
    expect(r.unresolved[0]?.suggestions).toEqual(['@examples/cli.py', '@src/flask/cli.py']);
    expect(r.unresolved[1]?.suggestions[0]).toBe('@routes_command');
    expect(r.unresolved[2]?.message).toMatch(/does not match/);
    expect(r.report).toContain('Not attached @routes_comand');
    expect(r.report).toContain('Did you mean @routes_command');
  });

  it('redacts secrets in attached content', async () => {
    const r = await resolveMentions('@config/settings.py', index);
    expect(r.attachments[0]?.content).not.toContain('hunter');
    expect(r.attachments[0]?.redactions).toBe(1);
    expect(r.report).toContain('1 secret(s) redacted');
  });

  it('truncates a large file and stops at the total budget', async () => {
    const r = await resolveMentions('@big/data.py @src/flask/cli.py @src/flask/helpers.py', index, {
      maxTotalTokens: 4100,
    });
    expect(r.attachments[0]).toMatchObject({ path: 'big/data.py', truncated: true });
    expect(r.attachments[0]?.content).toMatch(
      /To see more, read big\/data\.py with a line range\.\]$/,
    );
    expect(r.totalTokens).toBeLessThanOrEqual(4100);
    expect(r.unresolved.some((u) => /budget of 4100 tokens is used up/.test(u.message))).toBe(true);
  });

  it('attaches a file once even when mentioned twice', async () => {
    const r = await resolveMentions('@docs/cli.rst and again @file:docs/cli.rst', index);
    expect(r.attachments).toHaveLength(1);
  });
});
