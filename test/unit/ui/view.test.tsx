// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebviewToHost } from '../../../src/ui/protocol';
import { ApprovalCard } from '../../../src/ui/webview/approvalCard';
import { initialState, reduce, type TimelineItem } from '../../../src/ui/webview/state';
import { approvalView, isNearBottom, isThinking, streamingId } from '../../../src/ui/webview/view';

afterEach(() => {
  document.body.innerHTML = '';
});

const running = reduce(initialState, { type: 'status', state: 'running' });

describe('thread states', () => {
  it('thinks while busy with nothing streaming and no tool spinning', () => {
    expect(isThinking(initialState)).toBe(false);
    expect(isThinking(running)).toBe(true);
    const streaming = reduce(running, { type: 'text', messageId: 'm1', delta: 'Hi' });
    expect(isThinking(streaming)).toBe(false);
    expect(streamingId(streaming)).toBe('m1');
    const tool = reduce(running, {
      type: 'tool_start',
      toolCallId: 't',
      name: 'read_files',
      summary: 'a.py',
    });
    expect(isThinking(tool)).toBe(false);
    const toolDone = reduce(tool, {
      type: 'tool_end',
      toolCallId: 't',
      durationMs: 3,
      resultChars: 9,
      error: false,
    });
    expect(isThinking(toolDone)).toBe(true);
    expect(streamingId(reduce(streaming, { type: 'status', state: 'done' }))).toBeUndefined();
  });

  it('marks a stopped run with a chip and Retry', () => {
    const s = reduce(running, {
      type: 'status',
      state: 'cancelled',
      message: 'Cancelled. Workspace unchanged.',
    });
    expect(s.timeline.at(-1)).toMatchObject({ kind: 'notice', stopped: true, retry: true });
  });

  it('follows the thread only near the bottom', () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(860, 100, 1000)).toBe(true);
    expect(isNearBottom(500, 100, 1000)).toBe(false);
  });
});

const approval = (name: string, summary: string): Extract<TimelineItem, { kind: 'approval' }> => ({
  kind: 'approval',
  id: 'c1',
  threadId: 'main',
  name,
  summary,
  decision: 'pending',
});

describe('approval cards', () => {
  it('shows the exact command and its reason, with Allow and Deny', () => {
    const item = approval('run_command', 'flask --help\nReason: check the new command is listed');
    expect(approvalView(item)).toEqual({
      title: 'Run this command?',
      body: 'flask --help',
      reason: 'check the new command is listed',
      allow: 'Allow',
      deny: 'Deny',
    });
    const root = document.createElement('div');
    document.body.append(root);
    const sent: WebviewToHost[] = [];
    render(<ApprovalCard item={item} send={(m) => sent.push(m)} barVisible={false} />, root);
    expect(root.querySelector('.approval-command')?.textContent).toBe('flask --help');
    root.querySelector<HTMLButtonElement>('[aria-label="Allow: flask --help"]')?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Deny: flask --help"]')?.click();
    expect(sent).toEqual([
      { type: 'approve', toolCallId: 'c1', allow: true },
      { type: 'approve', toolCallId: 'c1', allow: false, reason: 'Denied by the user' },
    ]);
  });

  it('shows the decision once made', () => {
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <ApprovalCard
        item={{ ...approval('run_command', 'ls'), decision: 'denied' }}
        send={() => undefined}
        barVisible={false}
      />,
      root,
    );
    expect(root.textContent).toContain('Denied');
    expect(root.querySelector('button')).toBeNull();
  });

  it('points the change-set review at the files-changed bar', () => {
    const item = approval('submit_change_set', 'Add config\nmodify a.py (1 block(s))');
    expect(approvalView(item)).toMatchObject({ allow: 'Apply accepted', deny: 'Discard' });
    const root = document.createElement('div');
    document.body.append(root);
    render(<ApprovalCard item={item} send={() => undefined} barVisible />, root);
    expect(root.textContent).toContain('files-changed bar');
    expect(approvalView(approval('other_tool', 'x')).title).toBe('Allow other_tool?');
    expect(approvalView(approval('run_command', 'pytest')).reason).toBeUndefined();
  });
});
