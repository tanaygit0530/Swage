// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../../src/ui/protocol';

/** The whole panel (main.tsx) in jsdom, driven by host messages like the extension sends. */

const sent: WebviewToHost[] = [];
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const host = async (...msgs: HostToWebview[]): Promise<void> => {
  for (const data of msgs) window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
};
const $ = (sel: string): HTMLElement | null => document.querySelector(sel);

beforeAll(async () => {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewToHost) => sent.push(m),
  });
  document.body.innerHTML = '<div id="root"></div>';
  await import('../../../src/ui/webview/main');
  await tick();
});

describe('agent panel', () => {
  it('says ready and shows the empty state with the logo', () => {
    expect(sent[0]).toEqual({ type: 'ready' });
    expect($('.empty .swage-logo')).not.toBeNull();
    expect($('.empty-name')?.textContent).toBe('Swage');
    expect($('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('runs a turn: user bubble, thinking dots, streamed Markdown with an avatar', async () => {
    await host(
      { type: 'init', workspace: 'flask', model: 'Gemini', mode: 'planning' },
      { type: 'user', text: 'Add a config command' },
      { type: 'status', state: 'running', message: 'Running…' },
    );
    expect($('.msg.user')?.textContent).toBe('Add a config command');
    expect($('.thinking .dots')).not.toBeNull();
    expect($('[aria-label="Stop"]')).not.toBeNull();
    await host({ type: 'text', messageId: 'm1', delta: 'I will edit `src/flask/cli.py`.' });
    expect($('.thinking')).toBeNull();
    expect($('.turn .avatar .swage-logo')).not.toBeNull();
    expect($('.msg.assistant.streaming .chip')?.textContent).toContain('cli.py');
  });

  it('shows tool rows, edit cards, the bar and the walkthrough', async () => {
    await host(
      {
        type: 'tool_start',
        toolCallId: 't1',
        name: 'stage_edit',
        summary: 'edit src/flask/cli.py',
      },
      {
        type: 'changes',
        phase: 'staging',
        files: [
          {
            path: 'src/flask/cli.py',
            kind: 'modify',
            added: 12,
            removed: 1,
            decision: 'pending',
            blocks: [
              {
                id: 'b1',
                state: 'pending',
                added: 12,
                removed: 1,
                line: 40,
                summary: 'def config',
              },
            ],
          },
        ],
      },
    );
    expect($('.tool-label')?.textContent).toBe('Staging an edit to src/flask/cli.py');
    expect($('.fb-row.editing .spinner')).not.toBeNull();
    await host(
      { type: 'tool_end', toolCallId: 't1', durationMs: 40, resultChars: 90, error: false },
      {
        type: 'edit',
        taskId: 'x',
        path: 'src/flask/cli.py',
        kind: 'modify',
        added: 12,
        removed: 1,
      },
      { type: 'walkthrough', summary: 'Added `flask config`.', files: [] },
      {
        type: 'changes',
        phase: 'review',
        files: [
          {
            path: 'src/flask/cli.py',
            kind: 'modify',
            added: 12,
            removed: 1,
            decision: 'pending',
            blocks: [
              {
                id: 'b1',
                state: 'pending',
                added: 12,
                removed: 1,
                line: 40,
                summary: 'def config',
              },
            ],
          },
        ],
      },
    );
    expect($('.edit-card')?.textContent).toContain('Edited');
    expect($('.walkthrough')).not.toBeNull();
    expect($('.fb-title')?.textContent).toBe('1 File With Changes');
    ($('[aria-label="Accept all changes and apply them"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'acceptAll' });
    await host({ type: 'applied', files: 1, message: 'Applied 1 file(s)' });
    expect($('.files-bar')).toBeNull();
    expect($('.toast')?.textContent).toContain('Applied 1 file.');
    ($('[aria-label="Undo the applied change set"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'undo' });
    await tick();
    expect($('.toast')).toBeNull();
  });

  it('shows the Plan card, a fallback banner with Switch back, and a stopped run', async () => {
    await host(
      { type: 'plan', steps: ['Add it'], files: [], toolCallId: 'p1', awaiting: true },
      {
        type: 'notice',
        tone: 'warning',
        message: 'Switched to Groq because Gemini returned 429.',
        switchedFrom: 'primary',
      },
      { type: 'recovered', name: 'primary', label: 'Gemini' },
    );
    ($('[aria-label="Approve the plan"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'planDecision', toolCallId: 'p1', approve: true });
    await tick();
    expect($('.plan-status')?.textContent).toBe('Approving…');
    ($('[aria-label="Switch back to Gemini"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'selectModel', name: 'primary' });
    await host({ type: 'status', state: 'cancelled', message: 'Cancelled. Workspace unchanged.' });
    expect($('.stopped-chip')?.textContent).toBe('Stopped');
    expect($('[aria-label="Stopping…"]')).not.toBeNull();
    await host({ type: 'drained' });
    expect($('[aria-label="Send"]')).not.toBeNull();
    ($('[aria-label="Retry the request"]') as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ type: 'retry' });
  });

  it('focuses the composer on Cmd+L and offers Jump to latest after scrolling up', async () => {
    await host({ type: 'focusComposer' });
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    const log = $('[role="log"]') as HTMLElement;
    Object.defineProperty(log, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 300, configurable: true });
    log.scrollTop = 100;
    log.dispatchEvent(new Event('scroll'));
    await tick();
    const pill = $('[aria-label="Jump to the latest message"]') as HTMLButtonElement;
    expect(pill).not.toBeNull();
    pill.click();
    await tick();
    expect($('[aria-label="Jump to the latest message"]')).toBeNull();
  });
});
