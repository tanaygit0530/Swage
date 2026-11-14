// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeFile, WebviewToHost } from '../../../src/ui/protocol';
import { barModel } from '../../../src/ui/webview/changes';
import { FilesBar, Toast } from '../../../src/ui/webview/filesBar';
import type { PanelState } from '../../../src/ui/webview/state';

afterEach(() => {
  document.body.innerHTML = '';
});

const file = (path: string, over: Partial<ChangeFile> = {}): ChangeFile => ({
  path,
  kind: 'modify',
  added: 5,
  removed: 1,
  decision: 'pending',
  blocks: [
    { id: 'b1', state: 'pending', added: 4, removed: 1, line: 3, summary: 'def config():' },
    { id: 'b2', state: 'pending', added: 1, removed: 0, line: 20, summary: 'import json' },
  ],
  ...over,
});

function mount(changes: PanelState['changes'], timeline: PanelState['timeline'] = []) {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: WebviewToHost[] = [];
  render(<FilesBar model={barModel({ changes, timeline })} send={(m) => sent.push(m)} />, root);
  const button = (label: string): HTMLButtonElement => {
    const b = root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (!b) throw new Error(`no button ${label}`);
    return b;
  };
  return { root, sent, button };
}

describe('files-changed bar', () => {
  it('renders nothing without changes', () => {
    const { root } = mount({ phase: 'none', files: [] });
    expect(root.innerHTML).toBe('');
  });

  it('lists files by path with signed counts and the footer', () => {
    const { root } = mount({
      phase: 'review',
      files: [file('templates/index.html'), file('main.py', { added: 68, removed: 0 })],
    });
    expect([...root.querySelectorAll('.fb-name')].map((n) => n.textContent)).toEqual([
      'main.py',
      'index.html',
    ]);
    expect(root.querySelector('.fb-dir')?.textContent).toBe('templates');
    expect(root.querySelector('.fb-title')?.textContent).toBe('2 Files With Changes');
    expect(root.querySelector('.fb-footer .counts')?.textContent).toBe('+73 -1');
  });

  it('opens diffs, expands blocks and sends block and file decisions', async () => {
    const { root, sent, button } = mount({ phase: 'review', files: [file('a.py')] });
    root.querySelector<HTMLButtonElement>('.fb-main')?.click();
    button('Show the 2 change blocks of a.py').click();
    await new Promise((r) => setTimeout(r, 0));
    button('Accept block 1 of a.py').click();
    button('Reject block 2 of a.py').click();
    button('Split block 1 of a.py into line-sized blocks').click();
    root.querySelector<HTMLButtonElement>('.fb-block-main')?.click();
    button('Accept file a.py').click();
    button('Reject file a.py').click();
    expect(sent).toEqual([
      { type: 'openDiff', path: 'a.py' },
      { type: 'reviewAction', action: 'acceptBlock', path: 'a.py', blockId: 'b1' },
      { type: 'reviewAction', action: 'rejectBlock', path: 'a.py', blockId: 'b2' },
      { type: 'reviewAction', action: 'splitBlock', path: 'a.py', blockId: 'b1' },
      { type: 'openDiff', path: 'a.py', blockId: 'b1' },
      { type: 'reviewAction', action: 'acceptFile', path: 'a.py' },
      { type: 'reviewAction', action: 'rejectFile', path: 'a.py' },
    ]);
    // A one-line block cannot be split.
    expect(
      root.querySelector('[aria-label="Split block 2 of a.py into line-sized blocks"]'),
    ).toBeNull();
  });

  it('sends Accept all and Reject all, and offers Apply accepted after a partial accept', () => {
    const { sent, button } = mount({
      phase: 'review',
      files: [
        file('a.py', {
          decision: 'partial',
          blocks: [
            { id: 'b1', state: 'accepted', added: 1, removed: 0, line: 1, summary: 'x' },
            { id: 'b2', state: 'pending', added: 1, removed: 0, line: 9, summary: 'y' },
          ],
        }),
      ],
    });
    button('Accept all changes and apply them').click();
    button('Reject all changes').click();
    button('Apply the 1 accepted block only').click();
    expect(sent.map((m) => m.type)).toEqual(['acceptAll', 'rejectAll', 'applyAccepted']);
  });

  it('marks accepted and rejected files with more than colour', () => {
    const { root } = mount({
      phase: 'review',
      files: [file('a.py', { decision: 'accepted' }), file('b.py', { decision: 'rejected' })],
    });
    expect(root.querySelector('.decision-accepted .fb-state')?.getAttribute('title')).toBe(
      'Accepted',
    );
    expect(root.querySelector('.decision-rejected .fb-main')?.getAttribute('aria-label')).toContain(
      'rejected',
    );
  });

  it('is read-only while the agent is staging, with a spinner on the file being edited', () => {
    const { root, button } = mount({ phase: 'staging', files: [file('a.py')] }, [
      { kind: 'tool', id: 't', name: 'stage_edit', summary: 'edit a.py', status: 'running' },
    ]);
    expect(button('Accept all changes and apply them').disabled).toBe(true);
    expect(button('Reject all changes').disabled).toBe(true);
    expect(root.querySelector('.fb-row-actions')).toBeNull();
    expect(root.querySelector('[aria-label="Being edited"]')).not.toBeNull();
    expect(root.querySelector('.fb-hint')?.textContent).toBe('Agent is editing…');
  });

  it('collapses and expands the list from the footer chevron', () => {
    const { root, button } = mount({ phase: 'review', files: [file('a.py')] });
    button('Hide the changed files').click();
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(root.querySelector('.fb-rows')).toBeNull();
      button('Show the changed files').click();
      await new Promise((r) => setTimeout(r, 0));
      expect(root.querySelector('.fb-rows')).not.toBeNull();
    });
  });
});

describe('files-changed bar: status letters and per-file results', () => {
  it('shows M, A and D, a partial badge, and settled files without controls', () => {
    const { root } = mount({
      phase: 'review',
      files: [
        file('a.py', { decision: 'partial' }),
        file('b.py', { kind: 'create', settled: 'applied', decision: 'accepted' }),
        file('c.py', { kind: 'delete', settled: 'discarded', decision: 'rejected' }),
      ],
    });
    expect([...root.querySelectorAll('.fb-letter')].map((n) => n.textContent)).toEqual([
      'M',
      'A',
      'D',
    ]);
    expect(root.querySelector('.decision-partial .fb-badge')?.textContent).toBe('partial');
    expect(root.querySelector('.settled-applied .fb-state')?.getAttribute('title')).toBe('Applied');
    expect(root.querySelector('.settled-discarded .fb-state-text')?.textContent).toBe('discarded');
    // Only the open file keeps its controls, and the footer counts open files.
    expect(root.querySelectorAll('.fb-row-actions')).toHaveLength(1);
    expect(root.querySelector('.fb-title')?.textContent).toBe('1 File With Changes');
  });
});

describe('toast', () => {
  it('calls Undo and Dismiss', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const onUndo = vi.fn();
    const onClose = vi.fn();
    render(<Toast text="Applied 3 files." undo onUndo={onUndo} onClose={onClose} />, root);
    root.querySelector<HTMLButtonElement>('[aria-label="Undo the applied change set"]')?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')?.click();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(root.textContent).toContain('Applied 3 files.');
  });
});
