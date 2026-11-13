import { describe, expect, it } from 'vitest';
import { summarizeArgs } from '../../../src/ui/protocol';
import { changeRows } from '../../../src/ui/changes';
import { barModel } from '../../../src/ui/webview/changes';
import {
  applyWorkflow,
  rankCompletions,
  slashQuery,
  WORKFLOWS,
} from '../../../src/ui/webview/composer';
import { fileIcon } from '../../../src/ui/webview/fileIcon';
import {
  dismissToast,
  initialState,
  reduce,
  reducePanel,
  type PanelState,
} from '../../../src/ui/webview/state';
import { toolLabel } from '../../../src/ui/webview/tools';

/** The less travelled branches of the panel's pure modules. */

describe('summaries and labels', () => {
  it('summarises every tool argument shape', () => {
    const j = (o: unknown): string => JSON.stringify(o);
    expect(summarizeArgs('read_files', j({}))).toBe('');
    expect(summarizeArgs('read_files', j({ files: [{}, { path: 'a.py' }] }))).toBe(', a.py');
    expect(summarizeArgs('declare_context', j({}))).toBe('0 file(s)');
    expect(summarizeArgs('repo_map', j({}))).toBe('whole repository');
    expect(summarizeArgs('repo_map', j({ path_prefix: 'src' }))).toBe('src');
    expect(summarizeArgs('get_symbol', j({ name: 3 }))).toBe('3');
    expect(summarizeArgs('mystery', j({ a: 1, b: 2 }))).toBe('a, b');
    expect(summarizeArgs('read_files', 'not json')).toBe('not json');
  });

  it('labels running and finished rows with and without details', () => {
    expect(toolLabel({ name: 'read_files', summary: '', status: 'ok' })).toBe('Read files');
    expect(toolLabel({ name: 'find_relevant_code', summary: '"x"', status: 'running' })).toBe(
      'Searching code: x',
    );
    expect(toolLabel({ name: 'run_tests', summary: '', status: 'running' })).toBe('Running tests');
    expect(toolLabel({ name: 'mystery', summary: '', status: 'ok', outcome: 'fine' })).toBe(
      'mystery (fine)',
    );
    expect(fileIcon('archive.weird').label).toBe('File');
    expect(fileIcon('dir.with.dots/README').label).toBe('File');
  });
});

describe('composer edge cases', () => {
  it('handles a missing workflow match and empty queries', () => {
    expect(slashQuery('/x', 0)).toBeUndefined();
    const w = WORKFLOWS[0];
    if (!w) throw new Error('missing');
    expect(applyWorkflow('', 0, w)).toEqual({ text: '', cursor: 0 });
    expect(rankCompletions([], 'file:')).toEqual([]);
  });
});

describe('change rows: kinds without reasons, staged blocks without preview lines', () => {
  it('keeps rows without a reason and orders equal paths stably', () => {
    const rows = changeRows(
      [
        { path: 'b.py', kind: 'delete', blocks: [] },
        { path: 'a.py', kind: 'create', blocks: [] },
      ],
      () => '',
    );
    expect(rows.map((r) => [r.path, r.reason, r.decision])).toEqual([
      ['a.py', undefined, 'pending'],
      ['b.py', undefined, 'pending'],
    ]);
  });

  it('counts accepted, rejected and pending blocks across rows', () => {
    const state: Pick<PanelState, 'changes' | 'timeline'> = {
      timeline: [],
      changes: {
        phase: 'review',
        files: [
          {
            path: 'a.py',
            kind: 'modify',
            added: 1,
            removed: 1,
            decision: 'accepted',
            blocks: [{ id: 'b', state: 'accepted', added: 1, removed: 1, line: 1, summary: 's' }],
          },
        ],
      },
    };
    expect(barModel(state)).toMatchObject({ accepted: 1, pending: 0, canApplyAccepted: false });
  });
});

describe('reducer edge cases', () => {
  it('ignores stale toasts, unknown recoveries and tool errors', () => {
    expect(dismissToast(initialState, 3)).toBe(initialState);
    const applied = reduce(initialState, { type: 'applied', files: 2, message: '' });
    expect(reducePanel(applied, { type: 'local.dismissToast', id: 99 }).toast).toBeDefined();
    expect(reduce(initialState, { type: 'recovered', name: 'x', label: 'X' })).toBe(initialState);
    let s = reduce(initialState, {
      type: 'tool_start',
      toolCallId: 't',
      name: 'run_tests',
      summary: 'pytest',
    });
    s = reduce(s, {
      type: 'tool_end',
      toolCallId: 't',
      durationMs: 1,
      resultChars: 2,
      error: true,
    });
    expect(s.timeline[0]).toMatchObject({ status: 'error' });
    // A plan denied from Fast mode stays read-only; an unrelated approval leaves plans alone.
    s = reduce(reduce(initialState, { type: 'plan', steps: [], files: [], toolCallId: 'p' }), {
      type: 'approval_resolved',
      toolCallId: 'p',
      allowed: false,
    });
    expect(s.timeline[0]).toMatchObject({ gate: 'view' });
    expect(reducePanel(s, { type: 'local.plan', id: 'other', event: 'approve' })).toEqual(s);
  });

  it('names the model from the list, or keeps the old name when the active one is missing', () => {
    const s = reduce(initialState, {
      type: 'models',
      active: 'gone',
      items: [{ name: 'a', label: 'A', model: 'p/a' }],
    });
    expect(s.model).toBe('');
    const t = reduce(s, {
      type: 'models',
      active: 'a',
      items: [{ name: 'a', label: 'A', model: 'p/a' }],
    });
    expect(t.model).toBe('A (p/a)');
  });

  it('keeps Stopping across a repeated cancelled status', () => {
    let s = reduce(initialState, { type: 'status', state: 'running' });
    s = reduce(s, { type: 'status', state: 'cancelled' });
    s = reduce(s, { type: 'status', state: 'cancelled' });
    expect(s.stopping).toBe(true);
    const old = reduce(reduce(s, { type: 'drained' }), { type: 'status', state: 'cancelled' });
    expect(old.stopping).toBe(false);
  });
});

describe('summaries of tool calls with missing or odd arguments', () => {
  it('never throws, whatever the model sent', () => {
    const j = (o: unknown): string => JSON.stringify(o);
    expect(summarizeArgs('run_tests', j({}))).toBe('');
    expect(summarizeArgs('run_command', j({ reason: 'x' }))).toBe('');
    expect(summarizeArgs('find_relevant_code', j({}))).toBe('""');
    expect(summarizeArgs('stage_edit', j({ path: 'a.py' }))).toBe(' a.py');
    expect(summarizeArgs('read_files', j({ files: 'a.py' }))).toBe('');
    expect(summarizeArgs('read_files', j({ files: [null, { path: 'b.py' }] }))).toBe(', b.py');
    expect(summarizeArgs('declare_context', j({ files: 'x' }))).toBe('0 file(s)');
    expect(summarizeArgs('get_symbol', j({}))).toBe('');
    expect(summarizeArgs('submit_change_set', j({}))).toBe('');
    expect(summarizeArgs('run_tests', undefined as unknown as string)).toBe('');
  });
});
