import { describe, expect, it } from 'vitest';
import type { ReviewFile } from '../../../src/changeset/changeSet';
import { blockSummary, changeRows, fileDecision } from '../../../src/ui/changes';
import { barModel, barTitle, createdFiles, editingPaths } from '../../../src/ui/webview/changes';
import { initialState, reduce, type PanelState } from '../../../src/ui/webview/state';
import type { ChangeFile } from '../../../src/ui/protocol';

const block = (
  id: string,
  state: 'pending' | 'accepted' | 'rejected',
  oldStart: number,
  oldLines: string[],
  newLines: string[],
) => ({ id, state, oldStart, oldLines, newStart: oldStart, newLines, whitespaceOnly: false });

describe('change rows (host)', () => {
  const files: ReviewFile[] = [
    {
      path: 'src/flask/cli.py',
      kind: 'modify',
      blocks: [
        block('b1', 'accepted', 1, ['old\n'], ['new one\n', 'new two\n']),
        block('b2', 'pending', 3, ['gone\n'], []),
      ],
    },
    { path: 'docs/cli.rst', kind: 'create', blocks: [block('b1', 'pending', 0, [], ['Config\n'])] },
  ];
  const base = (p: string): string => (p === 'docs/cli.rst' ? '' : 'a\nold\nb\ngone\nc\n');

  it('orders by path, counts lines and keeps reasons', () => {
    const rows = changeRows(files, base, new Map([['docs/cli.rst', 'document the command']]));
    expect(rows.map((r) => r.path)).toEqual(['docs/cli.rst', 'src/flask/cli.py']);
    expect(rows[0]).toMatchObject({
      kind: 'create',
      added: 1,
      removed: 0,
      reason: 'document the command',
    });
    expect(rows[1]).toMatchObject({ added: 2, removed: 2, decision: 'partial' });
    expect(rows[1]?.blocks.map((b) => [b.line, b.summary])).toEqual([
      [2, 'new one'],
      [5, 'Removes: gone'],
    ]);
  });

  it('decides a file from its blocks', () => {
    expect(fileDecision([])).toBe('pending');
    expect(fileDecision(['accepted', 'accepted'])).toBe('accepted');
    expect(fileDecision(['rejected'])).toBe('rejected');
    expect(fileDecision(['pending', 'pending'])).toBe('pending');
    expect(fileDecision(['accepted', 'rejected'])).toBe('partial');
  });

  it('summarises blocks in one line', () => {
    expect(blockSummary(['', '  x = 1  '], [])).toBe('x = 1');
    expect(blockSummary([], [])).toBe('No change');
    expect(blockSummary(['', ''], [])).toBe('Blank lines');
    expect(blockSummary(['y'.repeat(100)], []).length).toBe(80);
  });
});

const file = (path: string, over: Partial<ChangeFile> = {}): ChangeFile => ({
  path,
  kind: 'modify',
  added: 1,
  removed: 0,
  decision: 'pending',
  blocks: [{ id: 'b1', state: 'pending', added: 1, removed: 0, line: 1, summary: 'x' }],
  ...over,
});

describe('files-changed bar model (webview)', () => {
  it('is hidden with nothing to show', () => {
    expect(barModel(initialState).visible).toBe(false);
  });

  it('orders rows, totals counts and blocks', () => {
    const m = barModel({
      timeline: [],
      changes: {
        phase: 'review',
        files: [
          file('static/css/style.css', { added: 129 }),
          file('main.py', {
            added: 68,
            removed: 2,
            decision: 'partial',
            blocks: [
              { id: 'b1', state: 'accepted', added: 60, removed: 0, line: 1, summary: 'a' },
              { id: 'b2', state: 'rejected', added: 8, removed: 2, line: 70, summary: 'b' },
            ],
          }),
        ],
      },
    });
    expect(m.visible).toBe(true);
    expect(m.rows.map((r) => r.path)).toEqual(['main.py', 'static/css/style.css']);
    expect([m.files, m.added, m.removed, m.blocks, m.accepted, m.rejected, m.pending]).toEqual([
      2, 197, 2, 3, 1, 1, 1,
    ]);
    expect(m.canDecide).toBe(true);
    expect(m.canApplyAccepted).toBe(true);
  });

  it('shows a spinner on files being staged, even before their first row', () => {
    const state: Pick<PanelState, 'changes' | 'timeline'> = {
      changes: { phase: 'staging', files: [file('a.py')] },
      timeline: [
        { kind: 'tool', id: 't1', name: 'stage_edit', summary: 'edit a.py', status: 'running' },
        { kind: 'tool', id: 't2', name: 'stage_edit', summary: 'write new.py', status: 'running' },
        { kind: 'tool', id: 't3', name: 'stage_edit', summary: 'edit done.py', status: 'ok' },
      ],
    };
    expect([...editingPaths(state.timeline)]).toEqual(['a.py', 'new.py']);
    const m = barModel(state);
    expect(m.rows.map((r) => [r.path, r.editing])).toEqual([
      ['a.py', true],
      ['new.py', true],
    ]);
    expect(m.canDecide).toBe(false);
    expect(m.canApplyAccepted).toBe(false);
  });

  it('works for one file with one block', () => {
    const m = barModel({ timeline: [], changes: { phase: 'review', files: [file('a.py')] } });
    expect(barTitle(m.files)).toBe('1 File With Changes');
    expect(barTitle(4)).toBe('4 Files With Changes');
    expect(m.canApplyAccepted).toBe(false);
  });

  it('lists created files in path order', () => {
    expect(
      createdFiles([
        { path: 'b.txt', kind: 'create' },
        { path: 'x.py', kind: 'modify' },
        { path: 'a.txt', kind: 'create' },
      ]).map((f) => f.path),
    ).toEqual(['a.txt', 'b.txt']);
  });
});

describe('reducer: cards, bar and toast', () => {
  it('keeps one edited-file card per file and task, updated in place', () => {
    let s = reduce(initialState, {
      type: 'edit',
      taskId: 't',
      path: 'a.py',
      kind: 'modify',
      added: 1,
      removed: 0,
    });
    s = reduce(s, { type: 'text', messageId: 'm', delta: 'hi' });
    s = reduce(s, {
      type: 'edit',
      taskId: 't',
      path: 'a.py',
      kind: 'modify',
      added: 3,
      removed: 1,
      reason: 'r',
    });
    expect(s.timeline.map((t) => t.kind)).toEqual(['edit', 'assistant']);
    expect(s.timeline[0]).toMatchObject({ added: 3, removed: 1, reason: 'r' });
  });

  it('shows the bar, the walkthrough, and an Undo toast after apply', () => {
    let s = reduce(initialState, { type: 'changes', phase: 'review', files: [file('a.py')] });
    expect(s.changes.files).toHaveLength(1);
    s = reduce(s, { type: 'walkthrough', summary: 'Added a config command.', files: [] });
    expect(s.timeline.at(-1)).toMatchObject({ kind: 'walkthrough' });
    s = reduce(s, { type: 'applied', files: 3, message: 'Applied 3 file(s)' });
    expect(s.changes.phase).toBe('none');
    expect(s.toast).toMatchObject({ text: 'Applied 3 files.', undo: true });
    expect(reduce(s, { type: 'applied', files: 1, message: '' }).toast?.text).toBe(
      'Applied 1 file.',
    );
  });
});
