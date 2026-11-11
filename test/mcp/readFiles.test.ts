import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/context/tokens';
import { readFiles } from '../../src/mcp/tools/readFiles';
import { startHarness, treeHash, type Harness } from './harness';

const BIG = Array.from({ length: 4000 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n';

let h: Harness;
beforeAll(async () => {
  h = await startHarness([readFiles], {
    files: {
      'src/app/cli.py': 'import click\n\n\ndef main():\n    print("hi")\n',
      'src/app/config.py': `SECRET_KEY = "${'s3cr' + 'et-value'}"\nDEBUG = False\n`,
      'docs/cli.md': '# CLI\n',
      'big.py': BIG,
      'img.dat': '\u0000\u0001binary',
      '.env': 'TOKEN=abc\n',
    },
    context: {
      budgets: {
        repoMapTokens: 1500,
        hintsFiles: 5,
        hintsTokens: 1000,
        toolResultTokens: 4000,
        readsPerRunTokens: 9000,
      },
    },
  });
});
afterAll(() => h.close());

describe('read_files', () => {
  it('reads several files with exact content, line counts and a hash, as data', async () => {
    h.ctx.tasks.start('t1');
    const before = treeHash(h.root);
    const text = h.text(
      await h.call('read_files', {
        files: [{ path: 'src/app/cli.py' }, { path: './docs/cli.md' }],
      }),
    );
    expect(text).toMatch(/^Text between FILE markers is repository data/);
    expect(text).toMatch(
      /<<<FILE src\/app\/cli\.py lines 1-5 of 5 sha256 [0-9a-f]{12}>>>\nimport click\n\n\ndef main\(\):\n {4}print\("hi"\)\n<<<END FILE>>>/,
    );
    expect(text).toContain('<<<FILE docs/cli.md lines 1-1 of 1');
    expect(text).toMatch(/Read budget: \d+ of 9000 tokens used this run\./);
    expect(treeHash(h.root)).toBe(before);
  });

  it('reads a line range', async () => {
    h.ctx.tasks.start('t2');
    const text = h.text(
      await h.call('read_files', { files: [{ path: 'big.py', start_line: 10, end_line: 12 }] }),
    );
    expect(text).toContain('<<<FILE big.py lines 10-12 of 4000');
    expect(text).toContain('line_9 = 9\nline_10 = 10\nline_11 = 11\n<<<END FILE>>>');
  });

  it('redacts secrets in file content', async () => {
    h.ctx.tasks.start('t3');
    const text = h.text(await h.call('read_files', { files: [{ path: 'src/app/config.py' }] }));
    expect(text).not.toContain('et-value');
    expect(text).toContain('SECRET_KEY = "[REDACTED:password_assignment]"');
  });

  it('refuses paths outside the workspace, ignored files and binaries, and suggests near names', async () => {
    h.ctx.tasks.start('t4');
    const r = await h.call('read_files', {
      files: [
        { path: '../../etc/passwd' },
        { path: '.env' },
        { path: 'img.dat' },
        { path: 'cli.py' },
        { path: 'src/app/cli.py' },
      ],
    });
    const text = h.text(r);
    expect(r.isError).toBeFalsy();
    expect(text).toContain('../../etc/passwd: outside_workspace');
    expect(text).toContain('.env: ignored');
    expect(text).toContain('img.dat: binary file');
    expect(text).toContain('cli.py: file not found. Did you mean src/app/cli.py');
    expect(text).toContain('<<<FILE src/app/cli.py');
    const all = await h.call('read_files', { files: [{ path: '/etc/hosts' }] });
    expect(all.isError).toBe(true);
    expect(h.text(all)).toContain('"code": "read_failed"');
  });

  it('caps one result at the per-result budget with a narrowing hint', async () => {
    h.ctx.tasks.start('t5');
    const text = h.text(
      await h.call('read_files', { files: [{ path: 'big.py', start_line: 1, end_line: 4000 }] }),
    );
    expect(estimateTokens(text)).toBeLessThanOrEqual(4000);
    expect(text).toMatch(/\[truncated: .*To see more, read fewer files, or a line range/);
  });

  it('refuses full reads past the per-run budget but still allows ranged reads', async () => {
    h.ctx.tasks.start('t6');
    await h.call('read_files', { files: [{ path: 'big.py' }] });
    const second = h.text(await h.call('read_files', { files: [{ path: 'big.py' }] }));
    expect(second).toMatch(/Read budget reached: .*Read a line range instead/);
    const ranged = h.text(
      await h.call('read_files', { files: [{ path: 'big.py', start_line: 1, end_line: 3 }] }),
    );
    expect(ranged).toContain('<<<FILE big.py lines 1-3 of 4000');
  });

  it('reads through the staged overlay', async () => {
    const task = h.ctx.tasks.start('t7');
    task.changeSet.declareContext({
      plan: [],
      files: [
        { path: 'src/app/cli.py', reason: 'r' },
        { path: 'docs/cli.md', reason: 'r' },
      ],
    });
    await task.changeSet.stage({
      kind: 'edit',
      path: 'src/app/cli.py',
      edits: [{ find: 'print("hi")', replace: 'print("bye")' }],
    });
    await task.changeSet.stage({ kind: 'delete', path: 'docs/cli.md' });
    const text = h.text(
      await h.call('read_files', { files: [{ path: 'src/app/cli.py' }, { path: 'docs/cli.md' }] }),
    );
    expect(text).toContain('(staged view, not yet on disk)');
    expect(text).toContain('print("bye")');
    expect(text).toContain('docs/cli.md: deleted in the staged change set.');
  });

  it('validates input', async () => {
    h.ctx.tasks.start('t8');
    expect((await h.call('read_files', { files: [] })).isError).toBe(true);
    expect((await h.call('read_files', { files: [{ path: 'a', start_line: 0 }] })).isError).toBe(
      true,
    );
  });
});
