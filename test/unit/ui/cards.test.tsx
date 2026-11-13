// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../../src/ui/protocol';
import { EditCard, WalkthroughCard } from '../../../src/ui/webview/cards';

afterEach(() => {
  document.body.innerHTML = '';
});

function host(): { root: HTMLElement; sent: WebviewToHost[]; send: (m: WebviewToHost) => void } {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: WebviewToHost[] = [];
  return { root, sent, send: (m) => sent.push(m) };
}

describe('edited-file cards', () => {
  it('shows the verb, name, signed counts and opens the file or its diff', () => {
    const { root, sent, send } = host();
    render(
      <EditCard
        item={{
          kind: 'edit',
          id: 'e',
          path: 'docs/README.md',
          fileKind: 'modify',
          added: 2,
          removed: 1,
        }}
        send={send}
      />,
      root,
    );
    expect(root.textContent).toContain('Edited');
    expect(root.textContent).toContain('README.md');
    expect(root.querySelector('.counts')?.textContent).toBe('+2 -1');
    root.querySelector<HTMLButtonElement>('[aria-label="Open docs/README.md"]')?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Open diff of docs/README.md"]')?.click();
    expect(sent).toEqual([
      { type: 'openFile', path: 'docs/README.md' },
      { type: 'openDiff', path: 'docs/README.md' },
    ]);
  });

  it('opens a created file as a diff (it is not on disk yet)', () => {
    const { root, sent, send } = host();
    render(
      <EditCard
        item={{ kind: 'edit', id: 'e', path: 'new.py', fileKind: 'create', added: 5, removed: 0 }}
        send={send}
      />,
      root,
    );
    expect(root.textContent).toContain('Created');
    root.querySelector<HTMLButtonElement>('.file-link')?.click();
    expect(sent).toEqual([{ type: 'openDiff', path: 'new.py' }]);
  });
});

describe('walkthrough card', () => {
  it('shows the summary, numbered created files with reasons, and View', () => {
    const { root, sent, send } = host();
    const onView = vi.fn();
    render(
      <WalkthroughCard
        item={{
          kind: 'walkthrough',
          id: 'w',
          summary: 'Added **requirements** files.',
          files: [
            {
              path: 'apps/bot/requirements.txt',
              kind: 'create',
              added: 3,
              removed: 0,
              reason: 'aiogram, redis',
            },
            { path: 'README.md', kind: 'modify', added: 2, removed: 1 },
          ],
        }}
        send={send}
        onView={onView}
      />,
      root,
    );
    expect(root.querySelector('strong')?.textContent).toBe('requirements');
    expect(root.querySelectorAll('.created-files li')).toHaveLength(1);
    expect(root.querySelector('.created-files')?.textContent).toContain('aiogram, redis');
    expect(root.querySelectorAll('.walk-files li')).toHaveLength(2);
    root.querySelector<HTMLButtonElement>('[aria-label="View the files-changed bar"]')?.click();
    expect(onView).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>('.created-files .file-link')?.click();
    expect(sent).toEqual([{ type: 'openDiff', path: 'apps/bot/requirements.txt' }]);
  });
});
