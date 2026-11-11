import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declareContext } from '../../src/mcp/tools/declareContext';
import { startHarness, type Harness } from './harness';

const CLI =
  'import click\n\n\ndef routes_command():\n    click.echo("routes")\n\n\ndef helper():\n    return 1\n';
const declared: {
  taskId: string;
  plan: readonly string[];
  files: readonly { path: string; reason: string }[];
}[] = [];

let h: Harness;
beforeAll(async () => {
  h = await startHarness([declareContext], {
    files: {
      'src/cli.py': CLI,
      'src/use.py': 'from cli import helper\n\nhelper()\n',
      'docs/cli.md': '# CLI\n\nCommands.\n',
      'dup.py': 'x = 1\nx = 1\n',
    },
    context: {
      events: {
        onDeclare: (taskId, plan, files) => declared.push({ taskId, plan, files }),
      },
    },
  });
});
afterAll(() => h.close());

describe('declare_context', () => {
  it('records the plan and files with reasons, allows new files, and notifies the UI', async () => {
    h.ctx.tasks.start('t1');
    const text = h.text(
      await h.call('declare_context', {
        plan: ['Add the config command', 'Document it'],
        files: [
          { path: './src/cli.py', reason: 'register the command' },
          { path: 'tests/test_config.py', reason: 'new test' },
        ],
      }),
    );
    expect(text).toContain('Context declared: 2 file(s).');
    expect(text).toContain('1. Add the config command');
    expect(text).toContain('- src/cli.py (existing): register the command');
    expect(text).toContain('- tests/test_config.py (new): new test');
    expect(declared.at(-1)).toEqual({
      taskId: 't1',
      plan: ['Add the config command', 'Document it'],
      files: [
        { path: 'src/cli.py', reason: 'register the command' },
        { path: 'tests/test_config.py', reason: 'new test' },
      ],
    });
  });

  it('declares nothing when any path is outside the workspace or ignored', async () => {
    h.ctx.tasks.start('t2');
    const r = await h.call('declare_context', {
      plan: ['x'],
      files: [
        { path: 'src/cli.py', reason: 'ok file' },
        { path: '../outside.py', reason: 'bad' },
        { path: '.env', reason: 'secret' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('"code": "invalid_paths"');
    expect(h.text(r)).toContain('../outside.py: outside_workspace');
    expect(h.text(r)).toContain('.env: ignored');
    expect(h.ctx.tasks.current()?.changeSet.declaredContext.files).toEqual([]);
  });
});
