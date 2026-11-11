import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declareContext } from '../../src/mcp/tools/declareContext';
import { stageEdit } from '../../src/mcp/tools/stageEdit';
import { startHarness, treeHash, type Harness } from './harness';

const CLI =
  'import click\n\n\ndef routes_command():\n    click.echo("routes")\n\n\ndef helper():\n    return 1\n';
const declared: {
  taskId: string;
  plan: readonly string[];
  files: readonly { path: string; reason: string }[];
}[] = [];
const staged: string[] = [];

let h: Harness;
beforeAll(async () => {
  h = await startHarness([declareContext, stageEdit], {
    files: {
      'src/cli.py': CLI,
      'src/use.py': 'from cli import helper\n\nhelper()\n',
      'docs/cli.md': '# CLI\n\nCommands.\n',
      'dup.py': 'x = 1\nx = 1\n',
    },
    context: {
      events: {
        onDeclare: (taskId, plan, files) => declared.push({ taskId, plan, files }),
        onStage: (_t, p) => staged.push(p),
      },
    },
  });
});
afterAll(() => h.close());

describe('stage_edit', () => {
  it('requires declare_context first', async () => {
    h.ctx.tasks.start('t3');
    const r = await h.call('stage_edit', { path: 'src/cli.py', kind: 'delete' });
    expect(h.text(r)).toContain('"code": "context_not_declared"');
  });

  it('stages edits, writes and deletes in memory only', async () => {
    h.ctx.tasks.start('t4');
    const before = treeHash(h.root);
    await h.call('declare_context', {
      plan: ['change things'],
      files: ['src/cli.py', 'docs/cli.md', 'tests/test_config.py'].map((p) => ({
        path: p,
        reason: 'needed here',
      })),
    });
    const edit = h.text(
      await h.call('stage_edit', {
        path: 'src/cli.py',
        kind: 'edit',
        edits: [{ find: 'click.echo("routes")', replace: 'click.echo("all routes")' }],
      }),
    );
    expect(edit).toContain(
      'Staged modify of src/cli.py: 1 block(s), +1 -1 lines. Nothing is written to disk',
    );
    const created = h.text(
      await h.call('stage_edit', {
        path: 'tests/test_config.py',
        kind: 'write',
        content: 'def test_x():\n    pass\n',
      }),
    );
    expect(created).toContain('Staged create of tests/test_config.py');
    const removed = h.text(await h.call('stage_edit', { path: 'docs/cli.md', kind: 'delete' }));
    expect(removed).toContain('Staged delete of docs/cli.md');
    expect(removed).toContain('Staged so far: src/cli.py, tests/test_config.py, docs/cli.md.');
    expect(treeHash(h.root)).toBe(before);
    expect(readFileSync(path.join(h.root, 'src/cli.py'), 'utf8')).toBe(CLI);
    expect(staged).toEqual(
      expect.arrayContaining(['src/cli.py', 'tests/test_config.py', 'docs/cli.md']),
    );
  });

  it('passes change-set errors through as structured, actionable codes', async () => {
    h.ctx.tasks.start('t5');
    await h.call('declare_context', {
      plan: ['p'],
      files: [
        { path: 'dup.py', reason: 'dup test' },
        { path: 'src/cli.py', reason: 'trunc test' },
      ],
    });
    const ambiguous = JSON.parse(
      h.text(
        await h.call('stage_edit', {
          path: 'dup.py',
          kind: 'edit',
          edits: [{ find: 'x = 1', replace: 'x = 2' }],
        }),
      ),
    );
    expect(ambiguous.error).toMatchObject({
      code: 'anchor_ambiguous',
      path: 'dup.py',
      edit_index: 0,
      match_count: 2,
    });
    const missing = JSON.parse(
      h.text(
        await h.call('stage_edit', {
          path: 'dup.py',
          kind: 'edit',
          edits: [{ find: 'nope', replace: '' }],
        }),
      ),
    );
    expect(missing.error.code).toBe('anchor_not_found');
    const undeclared = JSON.parse(
      h.text(await h.call('stage_edit', { path: 'docs/cli.md', kind: 'delete' })),
    );
    expect(undeclared.error.code).toBe('undeclared_file');
    const truncated = JSON.parse(
      h.text(await h.call('stage_edit', { path: 'src/cli.py', kind: 'write', content: 'x\n' })),
    );
    expect(truncated.error.code).toBe('suspicious_truncation');
    const noEdits = JSON.parse(
      h.text(await h.call('stage_edit', { path: 'dup.py', kind: 'edit' })),
    );
    expect(noEdits.error.code).toBe('invalid_input');
    const noContent = JSON.parse(
      h.text(await h.call('stage_edit', { path: 'dup.py', kind: 'write' })),
    );
    expect(noContent.error.code).toBe('invalid_input');
    const outside = JSON.parse(
      h.text(await h.call('stage_edit', { path: '/etc/hosts', kind: 'delete' })),
    );
    expect(outside.error.code).toBe('outside_workspace');
  });

  it('warns when an edit deletes a symbol that is still used', async () => {
    h.ctx.tasks.start('t6');
    await h.call('declare_context', {
      plan: ['p'],
      files: [
        { path: 'src/cli.py', reason: 'remove helper' },
        { path: 'src/use.py', reason: 'caller' },
      ],
    });
    await h.call('stage_edit', {
      path: 'src/use.py',
      kind: 'edit',
      edits: [{ find: 'helper()\n', replace: 'helper()\nprint(1)\n' }],
    });
    const text = h.text(
      await h.call('stage_edit', {
        path: 'src/cli.py',
        kind: 'edit',
        edits: [{ find: '\n\ndef helper():\n    return 1\n', replace: '\n' }],
      }),
    );
    expect(text).toContain(
      'Warning: function helper was removed from src/cli.py but is still referenced in src/use.py',
    );
  });

  it('reports a no-op edit', async () => {
    h.ctx.tasks.start('t7');
    await h.call('declare_context', {
      plan: ['p'],
      files: [{ path: 'src/cli.py', reason: 'noop' }],
    });
    const text = h.text(
      await h.call('stage_edit', {
        path: 'src/cli.py',
        kind: 'edit',
        edits: [{ find: 'import click', replace: 'import click' }],
      }),
    );
    expect(text).toContain('No change: the staged content of src/cli.py equals the file on disk.');
  });
});
