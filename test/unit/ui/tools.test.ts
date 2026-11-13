import { describe, expect, it } from 'vitest';
import {
  argsPreview,
  effectiveToolName,
  resultPreview,
  toolOutcome,
} from '../../../src/ui/toolDetail';
import { fileIcon, splitPath } from '../../../src/ui/webview/fileIcon';
import { formatDuration, toolLabel } from '../../../src/ui/webview/tools';

describe('tool rows', () => {
  it('reads like a sentence, never like JSON', () => {
    expect(
      toolLabel({ name: 'find_relevant_code', summary: '"flask session cookies"', status: 'ok' }),
    ).toBe('Searched code: flask session cookies');
    expect(toolLabel({ name: 'read_files', summary: 'a.py, b.py, c.py', status: 'ok' })).toBe(
      'Read 3 files',
    );
    expect(toolLabel({ name: 'read_files', summary: 'a.py', status: 'running' })).toBe(
      'Reading 1 file',
    );
    expect(
      toolLabel({ name: 'run_tests', summary: 'pytest -q', status: 'ok', outcome: '12 passed' }),
    ).toBe('Ran tests (12 passed): pytest -q');
    expect(toolLabel({ name: 'stage_edit', summary: 'edit src/cli.py', status: 'ok' })).toBe(
      'Staged an edit to src/cli.py',
    );
    expect(toolLabel({ name: 'stage_edit', summary: 'write new.py', status: 'running' })).toBe(
      'Staging a write to new.py',
    );
    expect(toolLabel({ name: 'stage_edit', summary: 'delete old.py', status: 'ok' })).toBe(
      'Staged a delete of old.py',
    );
    for (const name of [
      'get_symbol',
      'repo_map',
      'declare_context',
      'run_command',
      'submit_change_set',
      'list_tools',
      'get_tool_info',
      'mystery',
    ]) {
      expect(toolLabel({ name, summary: 'x', status: 'ok' })).not.toMatch(/[{}]/);
      expect(toolLabel({ name, summary: '', status: 'running' }).length).toBeGreaterThan(3);
    }
  });

  it('formats durations', () => {
    expect(formatDuration(340)).toBe('340 ms');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('names the inner tool of a deferred call_tool', () => {
    expect(
      effectiveToolName('call_tool', JSON.stringify({ tool_name: 'run_tests', input: {} })),
    ).toBe('run_tests');
    expect(effectiveToolName('call_tool', 'not json')).toBe('call_tool');
    expect(effectiveToolName('call_tool', '{}')).toBe('call_tool');
    expect(effectiveToolName('read_files', '{}')).toBe('read_files');
  });

  it('previews arguments shortened and redacted', () => {
    // A key-shaped value built at run time, so no key-like literal is in the repository.
    const key = ['sk', 'abcdefghijklmnop', 'qrstuvwx1234'].join('-');
    const long = 'x'.repeat(500);
    const preview = argsPreview(
      JSON.stringify({
        path: 'a.py',
        content: long,
        note: `api_key = "${key}"`,
      }),
    );
    expect(preview).toContain('"path": "a.py"');
    expect(preview).toContain('(500 chars)');
    expect(preview).not.toContain(key);
    expect(argsPreview('not json')).toBe('not json');
    expect(
      argsPreview(
        JSON.stringify({
          blob: 'y'.repeat(150),
          more: 'z'.repeat(150),
          a: 'q'.repeat(150),
          b: 'w'.repeat(150),
          c: 'e'.repeat(150),
          d: 'r'.repeat(150),
          e: 't'.repeat(150),
          f: 'u'.repeat(150),
        }),
      ).length,
    ).toBeLessThan(1_600);
  });

  it('previews results truncated and redacted', () => {
    expect(resultPreview('  ok  ')).toBe('ok');
    const r = resultPreview(`token ghp_${'a'.repeat(36)} ${'z'.repeat(900)}`);
    expect(r).not.toContain(`ghp_${'a'.repeat(36)}`);
    expect(r).toMatch(/more chars\)$/);
  });

  it('summarises outcomes', () => {
    expect(toolOutcome('run_tests', '===== 12 passed, 1 failed in 0.3s', false)).toBe(
      '12 passed, 1 failed',
    );
    expect(toolOutcome('run_command', 'Exit code 2 in 30 ms.', false)).toBe('exit 2');
    expect(toolOutcome('run_tests', '{"error":{"code":"timeout"}}', true)).toBe('failed');
    expect(toolOutcome('run_tests', 'nothing', false)).toBeUndefined();
    expect(toolOutcome('stage_edit', '{"error":{"code":"anchor_not_found"}}', true)).toBe(
      'anchor not found',
    );
    expect(toolOutcome('stage_edit', 'boom', true)).toBe('failed');
    expect(
      toolOutcome('find_relevant_code', '1. a.py (score 3; x)\n2. b.py (score 2; y)', false),
    ).toBe('2 results');
    expect(toolOutcome('find_relevant_code', 'none', false)).toBeUndefined();
    expect(toolOutcome('read_files', 'text', false)).toBeUndefined();
  });

  it('gives every file a typed icon and splits paths', () => {
    expect(fileIcon('flask/cli.py').label).toBe('Python');
    expect(fileIcon('src/a.TSX').label).toBe('TypeScript');
    expect(fileIcon('Makefile').label).toBe('File');
    expect(splitPath('static/css/style.css')).toEqual({ name: 'style.css', dir: 'static/css' });
    expect(splitPath('main.py')).toEqual({ name: 'main.py', dir: '' });
  });
});
