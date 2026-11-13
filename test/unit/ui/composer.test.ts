import { describe, expect, it } from 'vitest';
import {
  applyWorkflow,
  fuzzyScore,
  placeholder,
  rankCompletions,
  rankFuzzy,
  rowsFor,
  sendButton,
  slashQuery,
  WORKFLOWS,
  workflowsFor,
} from '../../../src/ui/webview/composer';
import { initialState, reduce } from '../../../src/ui/webview/state';

describe('slash workflows', () => {
  it('opens only for / at the start of a line', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashQuery('/fix', 4)).toEqual({ start: 0, query: 'fix' });
    expect(slashQuery('hello\n/add te', 13)).toEqual({ start: 6, query: 'add te' });
    expect(slashQuery('a/b', 3)).toBeUndefined();
    expect(slashQuery('path /x', 7)).toBeUndefined();
  });

  it('lists the five workflows and filters them fuzzily', () => {
    expect(WORKFLOWS.map((w) => w.label)).toEqual([
      'Explain this file',
      'Fix failing test',
      'Add tests',
      'Write docstrings',
      'Refactor selection',
    ]);
    expect(workflowsFor('')).toHaveLength(5);
    expect(workflowsFor('fft')[0]?.id).toBe('fix-test');
    expect(workflowsFor('docs')[0]?.id).toBe('docstrings');
    expect(workflowsFor('zzz')).toEqual([]);
  });

  it('replaces the /query with the template', () => {
    const w = WORKFLOWS[1];
    if (!w) throw new Error('missing');
    const r = applyWorkflow('/fix', 4, w);
    expect(r.text).toBe(`${w.template} `);
    expect(r.cursor).toBe(w.template.length + 1);
    expect(applyWorkflow('no slash', 3, w)).toEqual({ text: 'no slash', cursor: 3 });
  });
});

describe('fuzzy matching for mentions', () => {
  it('scores subsequences, prefers word starts and runs', () => {
    expect(fuzzyScore('', 'x')).toBe(0);
    expect(fuzzyScore('xyz', 'abc')).toBe(-1);
    expect(fuzzyScore('cli', 'src/flask/cli.py')).toBeGreaterThan(
      fuzzyScore('cli', 'calendar_list_io.py'),
    );
    expect(rankFuzzy(['b', 'ab', 'abc'], 'ab', (s) => s)).toEqual(['ab', 'abc']);
  });

  it('re-ranks host completions and keeps the ones it matched on more than the label', () => {
    const items = [
      {
        kind: 'file' as const,
        label: 'tests/test_cli.py',
        detail: '',
        insertText: '@file:tests/test_cli.py',
      },
      {
        kind: 'file' as const,
        label: 'src/flask/cli.py',
        detail: '',
        insertText: '@file:src/flask/cli.py',
      },
      {
        kind: 'symbol' as const,
        label: 'FlaskGroup',
        detail: 'cli.py',
        insertText: '@symbol:FlaskGroup',
      },
    ];
    expect(rankCompletions(items, 'file:flcli').map((c) => c.label)).toEqual([
      'src/flask/cli.py',
      'tests/test_cli.py',
      'FlaskGroup',
    ]);
    expect(rankCompletions(items, '')).toEqual(items);
  });
});

describe('composer chrome', () => {
  it('names the platform shortcut in the placeholder', () => {
    expect(placeholder(true)).toBe('Ask anything (Cmd+L), @ to mention, / for workflows');
    expect(placeholder(false)).toBe('Ask anything (Ctrl+L), @ to mention, / for workflows');
  });

  it('grows the textarea with the text, up to 10 lines', () => {
    expect(rowsFor('')).toBe(1);
    expect(rowsFor('a\nb\nc')).toBe(3);
    expect(rowsFor('\n'.repeat(30))).toBe(10);
  });

  it('is Send when idle, Stop while running or paused, Stopping… until drained', () => {
    expect(sendButton('idle', false)).toBe('send');
    expect(sendButton('starting', false)).toBe('stop');
    expect(sendButton('running', false)).toBe('stop');
    expect(sendButton('paused', false)).toBe('stop');
    expect(sendButton('cancelling', false)).toBe('stopping');
    expect(sendButton('cancelled', true)).toBe('stopping');
    expect(sendButton('done', false)).toBe('send');
  });

  it('turns Stop into Send only after the cancelled turn has drained', () => {
    let s = reduce(initialState, { type: 'status', state: 'running' });
    expect(sendButton(s.status, s.stopping)).toBe('stop');
    s = reduce(s, {
      type: 'status',
      state: 'cancelled',
      message: 'Cancelled. Workspace unchanged.',
    });
    expect(sendButton(s.status, s.stopping)).toBe('stopping');
    s = reduce(s, { type: 'drained' });
    expect(sendButton(s.status, s.stopping)).toBe('send');
    // A run that ends normally never shows Stopping.
    s = reduce(reduce(s, { type: 'status', state: 'starting' }), { type: 'status', state: 'done' });
    expect(sendButton(s.status, s.stopping)).toBe('send');
  });
});

describe('reducer: mode, focus, attachments and fallback banners', () => {
  it('restores and changes the mode', () => {
    let s = reduce(initialState, { type: 'init', workspace: 'w', model: 'm', mode: 'fast' });
    expect(s.mode).toBe('fast');
    s = reduce(s, { type: 'mode', mode: 'planning' });
    expect(s.mode).toBe('planning');
    expect(reduce(s, { type: 'init', workspace: 'w', model: 'm' }).mode).toBe('planning');
  });

  it('counts focus requests and attachments', () => {
    let s = reduce(initialState, { type: 'focusComposer' });
    s = reduce(s, { type: 'attachment', text: '@file:a.py ' });
    s = reduce(s, { type: 'attachment', text: '@file:b.py ' });
    expect(s.focusSeq).toBe(1);
    expect(s.attachment).toEqual({ id: 2, text: '@file:b.py ' });
  });

  it('offers Switch back on the banner once the profile recovers', () => {
    let s = reduce(initialState, {
      type: 'notice',
      tone: 'warning',
      message: 'Switched to Groq because Gemini returned 429.',
      switchedFrom: 'primary',
    });
    s = reduce(s, { type: 'recovered', name: 'other', label: 'Other' });
    expect(s.timeline[0]).not.toHaveProperty('switchBack');
    s = reduce(s, { type: 'recovered', name: 'primary', label: 'Gemini' });
    expect(s.timeline[0]).toMatchObject({ switchBack: { name: 'primary', label: 'Gemini' } });
  });

  it('keeps the auto-fallback flag from the model list', () => {
    const s = reduce(initialState, {
      type: 'models',
      active: 'primary',
      items: [{ name: 'primary', label: 'Gemini', model: 'google/gemini' }],
      autoFallback: true,
    });
    expect(s.autoFallback).toBe(true);
  });

  it('marks failed runs for Retry', () => {
    const s = reduce(initialState, { type: 'status', state: 'error', message: 'boom' });
    expect(s.timeline[0]).toMatchObject({ kind: 'notice', tone: 'error', retry: true });
  });
});
