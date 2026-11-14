// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHostMessage,
  parseWebviewMessage,
  type WebviewToHost,
} from '../../../src/ui/protocol';
import { TurnReview } from '../../../src/ui/webview/cards';
import { barModel } from '../../../src/ui/webview/changes';
import { FilesBar } from '../../../src/ui/webview/filesBar';
import { initialState, reduce } from '../../../src/ui/webview/state';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(node: preact.ComponentChild): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(node, root);
  return root;
}

describe('per-turn review', () => {
  it('keeps the turns and tags walkthroughs with their turn', () => {
    let s = reduce(initialState, {
      type: 'walkthrough',
      taskId: 't1',
      summary: 'Done.',
      files: [],
    });
    expect(s.timeline[0]).toMatchObject({ kind: 'walkthrough', taskId: 't1' });
    s = reduce(s, {
      type: 'turns',
      current: 't1',
      latest: 't2',
      items: [{ taskId: 't1', label: 'Add config', files: 3, open: 2 }],
    });
    expect(s.turns).toEqual({
      current: 't1',
      latest: 't2',
      items: [{ taskId: 't1', label: 'Add config', files: 3, open: 2 }],
    });
  });

  it('shows "N files changed" with Review for a turn still waiting, and reviewed otherwise', () => {
    const sent: WebviewToHost[] = [];
    const root = mount(
      <TurnReview
        taskId="t1"
        files={3}
        turn={{ files: 4, open: 2 }}
        current={false}
        send={(m) => sent.push(m)}
      />,
    );
    expect(root.textContent).toContain('4 files changed');
    expect(root.textContent).toContain('2 to review');
    root
      .querySelector<HTMLButtonElement>('[aria-label="Review the 4 files of this turn"]')
      ?.click();
    expect(sent).toEqual([{ type: 'reviewTurn', taskId: 't1' }]);
    const done = mount(
      <TurnReview taskId="t2" files={1} turn={undefined} current={false} send={() => undefined} />,
    );
    expect(done.textContent).toContain('1 file changed');
    expect(done.textContent).toContain('reviewed');
    expect(done.querySelector('button')).toBeNull();
    const decided = mount(
      <TurnReview
        taskId="t3"
        files={2}
        turn={{ files: 2, open: 0 }}
        current
        send={() => undefined}
      />,
    );
    expect(decided.textContent).toContain('all decided');
  });

  it('heads the bar "For this turn" with Clear filter when an earlier turn is shown', () => {
    const sent: WebviewToHost[] = [];
    const model = barModel({
      timeline: [],
      changes: {
        phase: 'review',
        files: [
          {
            path: 'a.py',
            kind: 'modify',
            added: 1,
            removed: 0,
            decision: 'pending',
            blocks: [{ id: 'b1', state: 'pending', added: 1, removed: 0, line: 1, summary: 'x' }],
          },
        ],
      },
    });
    const root = mount(
      <FilesBar
        model={model}
        send={(m) => sent.push(m)}
        turn={{ label: 'Add config', latest: 't2' }}
      />,
    );
    expect(root.querySelector('.fb-turn-label')?.textContent).toBe('For this turn: Add config');
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Clear the turn filter and show the newest turn"]',
      )
      ?.click();
    expect(sent).toEqual([{ type: 'reviewTurn', taskId: 't2' }]);
    const plain = mount(<FilesBar model={model} send={() => undefined} />);
    expect(plain.querySelector('.fb-turn')).toBeNull();
  });

  it('validates the new messages', () => {
    expect(parseHostMessage({ type: 'turns', items: [] })).toBeDefined();
    expect(
      parseHostMessage({ type: 'turns', items: [{ taskId: 't', label: 'l', files: -1, open: 0 }] }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: 'reviewTurn', taskId: 't1' })).toBeDefined();
    expect(parseWebviewMessage({ type: 'reviewTurn' })).toBeUndefined();
  });
});

describe('review comments chip', () => {
  it('shows how many comments go with the next message, and clears them', async () => {
    const { Composer } = await import('../../../src/ui/webview/composerView');
    const sent: WebviewToHost[] = [];
    const state = reduce(initialState, {
      type: 'comments',
      items: [
        { id: 'c1', path: 'a.py', lines: '3-4', text: 'use a constant' },
        { id: 'c2', path: 'b.py', lines: '9', text: 'why?' },
      ],
    });
    const root = mount(<Composer state={state} send={(m) => sent.push(m)} />);
    expect(root.querySelector('.comment-chip')?.textContent).toContain('2 Comments');
    expect(root.querySelector('.comment-chip')?.getAttribute('title')).toBe(
      'a.py:3-4 use a constant\nb.py:9 why?',
    );
    root.querySelector<HTMLButtonElement>('[aria-label="Clear the review comments"]')?.click();
    expect(sent).toEqual([{ type: 'clearComments' }]);
    expect(parseHostMessage({ type: 'comments', items: [] })).toBeDefined();
    expect(parseWebviewMessage({ type: 'removeComment', id: 'c1' })).toBeDefined();
    expect(
      mount(<Composer state={initialState} send={() => undefined} />).querySelector(
        '.comment-chip',
      ),
    ).toBeNull();
  });
});
