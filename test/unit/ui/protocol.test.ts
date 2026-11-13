import { describe, expect, it } from 'vitest';
import { parseHostMessage, parseWebviewMessage, summarizeArgs } from '../../../src/ui/protocol';
import {
  applyCompletion,
  initialState,
  isBusy,
  mentionQuery,
  reduce,
  type PanelState,
} from '../../../src/ui/webview/state';

describe('message validation', () => {
  it('accepts well-formed messages in both directions', () => {
    expect(parseWebviewMessage({ type: 'submit', text: '  add a config command ' })).toEqual({
      type: 'submit',
      text: 'add a config command',
    });
    expect(
      parseWebviewMessage({ type: 'approve', toolCallId: 'c1', allow: false, reason: 'no' }),
    ).toBeDefined();
    expect(parseWebviewMessage({ type: 'complete', requestId: 3, query: 'cli' })).toBeDefined();
    expect(
      parseHostMessage({
        type: 'tool_end',
        toolCallId: 'c1',
        durationMs: 12,
        resultChars: 300,
        error: false,
      }),
    ).toBeDefined();
    expect(
      parseHostMessage({
        type: 'budget',
        used: 10,
        total: 100,
        parts: [{ label: 'repo map', tokens: 10 }],
      }),
    ).toBeDefined();
  });

  it('drops malformed or unexpected messages', () => {
    for (const bad of [
      null,
      'submit',
      { type: 'submit', text: '   ' },
      { type: 'submit', text: 'x'.repeat(20_001) },
      { type: 'approve', toolCallId: 'c1' },
      { type: 'run_shell', command: 'rm -rf /' },
      { type: 'complete', requestId: 1.5, query: 'x' },
    ]) {
      expect(parseWebviewMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
    for (const bad of [
      { type: 'status', state: 'exploded' },
      { type: 'budget', used: -1, total: 10, parts: [] },
      { type: 'budget', used: 1, total: 0, parts: [] },
      { type: 'approval', calls: [] },
      { type: 'text', messageId: 'm' },
    ]) {
      expect(parseHostMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('summarizes tool arguments in one line', () => {
    expect(summarizeArgs('find_relevant_code', '{"query":"config command"}')).toBe(
      '"config command"',
    );
    expect(summarizeArgs('read_files', '{"files":[{"path":"a.py"},{"path":"b.py"}]}')).toBe(
      'a.py, b.py',
    );
    expect(summarizeArgs('stage_edit', '{"path":"a.py","kind":"edit","edits":[]}')).toBe(
      'edit a.py',
    );
    expect(summarizeArgs('declare_context', '{"plan":[],"files":[{},{}]}')).toBe('2 file(s)');
    expect(summarizeArgs('run_tests', '{"command":"npm test"}')).toBe('npm test');
    expect(summarizeArgs('repo_map', '{}')).toBe('whole repository');
    expect(summarizeArgs('get_symbol', '{"name":"load_config"}')).toBe('load_config');
    expect(summarizeArgs('submit_change_set', '{"summary":"Added it"}')).toBe('Added it');
    expect(summarizeArgs('other', '{"a":1,"b":2}')).toBe('a, b');
    expect(summarizeArgs('read_files', 'not json')).toBe('not json');
  });
});

describe('panel reducer', () => {
  const run = (...msgs: Parameters<typeof reduce>[1][]): PanelState =>
    msgs.reduce(reduce, initialState);

  it('fills the model picker and shows the active model, with a note on a failed one', () => {
    const s = run({
      type: 'models',
      active: 'fallback-1',
      items: [
        { name: 'primary', label: 'Gemini', model: 'google-gemini/flash', note: 'returned 429' },
        { name: 'fallback-1', label: 'Ollama', model: 'ollama/qwen' },
      ],
    });
    expect(s.models.active).toBe('fallback-1');
    expect(s.models.items).toHaveLength(2);
    expect(s.model).toBe('Ollama (ollama/qwen)');
    expect(parseWebviewMessage({ type: 'selectModel', name: 'primary' })).toEqual({
      type: 'selectModel',
      name: 'primary',
    });
    expect(parseWebviewMessage({ type: 'moreModels' })).toEqual({ type: 'moreModels' });
    expect(parseWebviewMessage({ type: 'selectModel' })).toBeUndefined();
  });

  it('shows a fallback banner and updates the model in the header', () => {
    const s = run(
      { type: 'init', workspace: 'w', model: 'Gemini' },
      { type: 'notice', tone: 'warning', message: 'Switched to Groq because Gemini returned 429.' },
      { type: 'model', model: 'Groq (groq/x)' },
    );
    expect(s.model).toBe('Groq (groq/x)');
    expect(s.timeline.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'warning',
      text: 'Switched to Groq because Gemini returned 429.',
    });
    expect(parseHostMessage({ type: 'notice', tone: 'loud', message: 'x' })).toBeUndefined();
  });

  it('streams assistant text into one message per message id', () => {
    const s = run(
      { type: 'user', text: 'do it' },
      { type: 'text', messageId: 'm1', delta: 'Hel' },
      { type: 'text', messageId: 'm1', delta: 'lo' },
      { type: 'text', messageId: 'm2', delta: 'Next' },
    );
    expect(
      s.timeline.map((t) =>
        t.kind === 'assistant' || t.kind === 'user' ? `${t.kind}:${t.text}` : t.kind,
      ),
    ).toEqual(['user:do it', 'assistant:Hello', 'assistant:Next']);
  });

  it('tracks tool rows from start to end, once per call', () => {
    const s = run(
      { type: 'tool_start', toolCallId: 'c1', name: 'read_files', summary: 'a.py' },
      { type: 'tool_start', toolCallId: 'c1', name: 'read_files', summary: 'a.py' },
      { type: 'tool_end', toolCallId: 'c1', durationMs: 5, resultChars: 120, error: false },
      { type: 'tool_start', toolCallId: 'c2', name: 'run_tests', summary: 'npm test' },
    );
    expect(s.timeline).toEqual([
      {
        kind: 'tool',
        id: 'c1',
        name: 'read_files',
        summary: 'a.py',
        status: 'ok',
        durationMs: 5,
        resultChars: 120,
      },
      { kind: 'tool', id: 'c2', name: 'run_tests', summary: 'npm test', status: 'running' },
    ]);
    const stopped = reduce(s, {
      type: 'status',
      state: 'cancelled',
      message: 'Cancelled. Workspace unchanged.',
    });
    expect(stopped.timeline[1]).toMatchObject({ status: 'stopped' });
    expect(stopped.timeline.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'Cancelled. Workspace unchanged.',
      tone: 'info',
    });
    expect(stopped.status).toBe('cancelled');
  });

  it('shows the plan, the budget, approvals and their resolution', () => {
    const s = run(
      { type: 'plan', steps: ['add', 'test'], files: [{ path: 'a.py', reason: 'defines it' }] },
      { type: 'budget', used: 1200, total: 30000, parts: [{ label: 'repo map', tokens: 800 }] },
      {
        type: 'approval',
        calls: [
          { toolCallId: 'c9', threadId: 'main', name: 'submit_change_set', summary: '3 files' },
        ],
      },
      { type: 'approval_resolved', toolCallId: 'c9', allowed: false },
      { type: 'error', message: 'boom' },
    );
    expect(s.timeline[0]).toMatchObject({ kind: 'plan', steps: ['add', 'test'] });
    expect(s.budget).toEqual({
      used: 1200,
      total: 30000,
      parts: [{ label: 'repo map', tokens: 800 }],
    });
    expect(s.timeline[1]).toMatchObject({ kind: 'approval', id: 'c9', decision: 'denied' });
    expect(s.timeline[2]).toMatchObject({ kind: 'notice', tone: 'error', text: 'boom' });
  });

  it('keeps only the newest completions and records init and status', () => {
    let s = run({ type: 'init', workspace: 'demo', model: 'swage-fake/three-file-edit' });
    s = reduce(s, {
      type: 'completions',
      requestId: 2,
      items: [{ kind: 'file', label: 'a.py', detail: 'python', insertText: '@a.py' }],
    });
    s = reduce(s, { type: 'completions', requestId: 1, items: [] });
    expect(s.completions.items).toHaveLength(1);
    expect(s.model).toBe('swage-fake/three-file-edit');
    s = reduce(s, { type: 'status', state: 'running' });
    expect(isBusy(s.status)).toBe(true);
    expect(isBusy('paused')).toBe(false);
    expect(s.timeline).toEqual([]);
  });
});

describe('mention completion helpers', () => {
  it('finds the @ query at the cursor', () => {
    expect(mentionQuery('fix @app/cl', 11)).toEqual({ start: 4, query: 'app/cl' });
    expect(mentionQuery('@sym', 4)).toEqual({ start: 0, query: 'sym' });
    expect(mentionQuery('(@file:docs', 11)).toEqual({ start: 1, query: 'file:docs' });
    expect(mentionQuery('mail me@example', 15)).toBeUndefined();
    expect(mentionQuery('no mention', 10)).toBeUndefined();
  });

  it('replaces the query with the chosen completion', () => {
    expect(applyCompletion('fix @app/cl please', 11, '@app/cli.py')).toEqual({
      text: 'fix @app/cli.py  please',
      cursor: 16,
    });
    expect(applyCompletion('nothing', 7, '@x')).toEqual({ text: 'nothing', cursor: 7 });
  });
});

describe('deferred tools called through call_tool', () => {
  it('summarizes the underlying arguments', async () => {
    const { parseToolArgs } = await import('../../../src/ui/protocol');
    const raw =
      '{"mcp_server":"editor-tools","tool_name":"run_tests","input":{"command":"npm test"}}';
    expect(parseToolArgs(raw)).toEqual({ command: 'npm test' });
    expect(summarizeArgs('run_tests', raw)).toBe('npm test');
    expect(parseToolArgs('{"command":"x"}')).toEqual({ command: 'x' });
    expect(parseToolArgs('nope')).toBeUndefined();
  });
});

describe('message validation: redesign step 2', () => {
  it('accepts the chip, code block and tool detail messages', () => {
    expect(parseWebviewMessage({ type: 'openFile', path: 'flask/cli.py', line: 3 })).toBeDefined();
    expect(parseWebviewMessage({ type: 'openFile', path: 'a.py' })).toBeDefined();
    expect(parseWebviewMessage({ type: 'openSymbol', name: 'get_debug_flag' })).toBeDefined();
    expect(parseWebviewMessage({ type: 'insertCode', text: 'x = 1' })).toBeDefined();
    expect(parseWebviewMessage({ type: 'copy', text: 'x' })).toBeDefined();
    expect(
      parseHostMessage({
        type: 'tool_start',
        toolCallId: 'c1',
        name: 'read_files',
        summary: 'a.py',
        args: '{"files":[]}',
      }),
    ).toBeDefined();
    expect(
      parseHostMessage({
        type: 'tool_end',
        toolCallId: 'c1',
        durationMs: 5,
        resultChars: 10,
        error: false,
        outcome: '3 passed',
        result: '3 passed in 0.1s',
      }),
    ).toBeDefined();
  });

  it('rejects malformed ones', () => {
    expect(parseWebviewMessage({ type: 'openFile', path: 'a.py', line: 0 })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'openFile' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'insertCode', text: 3 })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'copy', text: 'x'.repeat(200_001) })).toBeUndefined();
  });
});
