// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebviewToHost } from '../../../src/ui/protocol';
import { Composer, modelOptions } from '../../../src/ui/webview/composerView';
import { initialState, reduce, type PanelState } from '../../../src/ui/webview/state';

afterEach(() => {
  document.body.innerHTML = '';
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const models: PanelState['models'] = {
  active: 'primary',
  items: [
    { name: 'primary', label: 'Gemini Flash', model: 'google/gemini-flash' },
    { name: 'fallback-1', label: 'Groq Llama', model: 'groq/llama', note: 'returned 429' },
  ],
};

function mount(state: PanelState) {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: WebviewToHost[] = [];
  const send = (m: WebviewToHost): void => {
    sent.push(m);
  };
  render(<Composer state={state} send={send} />, root);
  const area = root.querySelector('textarea') as HTMLTextAreaElement;
  const type = async (value: string): Promise<void> => {
    area.value = value;
    area.setSelectionRange(value.length, value.length);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
  };
  const key = async (k: string, shift = false): Promise<void> => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
    await tick();
  };
  const rerender = async (next: PanelState): Promise<void> => {
    render(<Composer state={next} send={send} />, root);
    await tick();
  };
  return { root, sent, area, type, key, rerender };
}

describe('composer', () => {
  it('sends on Enter, not on Shift+Enter', async () => {
    const c = mount(initialState);
    expect(c.area.getAttribute('placeholder')).toMatch(
      /^Ask anything \((Cmd|Ctrl)\+L\), @ to mention, \/ for workflows$/,
    );
    await c.type('add a config command');
    await c.key('Enter', true);
    expect(c.sent).toEqual([]);
    await c.key('Enter');
    expect(c.sent).toEqual([{ type: 'submit', text: 'add a config command' }]);
  });

  it('opens the @ popup with the host completions and inserts the choice', async () => {
    const c = mount(initialState);
    await c.type('look at @cli');
    expect(c.sent.at(-1)).toEqual({ type: 'complete', requestId: 1, query: 'cli' });
    await c.rerender(
      reduce(initialState, {
        type: 'completions',
        requestId: 1,
        items: [
          {
            kind: 'file',
            label: 'tests/test_cli.py',
            detail: '',
            insertText: '@file:tests/test_cli.py',
          },
          {
            kind: 'file',
            label: 'src/flask/cli.py',
            detail: '',
            insertText: '@file:src/flask/cli.py',
          },
        ],
      }),
    );
    const options = c.root.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(c.root.querySelector('.popup .file-glyph')).not.toBeNull();
    await c.key('ArrowDown');
    expect(c.root.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    await c.key('Enter');
    expect(c.area.value).toMatch(/^look at @file:\S+ $/);
    expect(c.root.querySelector('.popup')).toBeNull();
  });

  it('opens the / popup and inserts a workflow, asking the host to attach the file', async () => {
    const c = mount(initialState);
    await c.type('/expl');
    expect(c.root.querySelector('.popup')?.textContent).toContain('Explain this file');
    await c.key('Enter');
    expect(c.area.value).toMatch(/^Explain what this file does/);
    expect(c.sent.at(-1)).toEqual({ type: 'attach', what: 'file' });
  });

  it('closes a popup with Escape', async () => {
    const c = mount(initialState);
    await c.type('/');
    expect(c.root.querySelector('.popup')).not.toBeNull();
    await c.key('Escape');
    expect(c.root.querySelector('.popup')).toBeNull();
  });

  it('inserts attachments from "+"', async () => {
    const c = mount(initialState);
    c.root
      .querySelector<HTMLButtonElement>('[aria-label="Attach the selection or the active file"]')
      ?.click();
    expect(c.sent).toEqual([{ type: 'attach', what: 'auto' }]);
    await c.rerender(reduce(initialState, { type: 'attachment', text: '@file:a.py ' }));
    expect(c.area.value).toBe('@file:a.py ');
  });

  it('shows Stop while running, Stopping… until drained, then Send', async () => {
    let state = reduce(initialState, { type: 'status', state: 'running' });
    const c = mount(state);
    const stop = c.root.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
    stop?.click();
    expect(c.sent).toEqual([{ type: 'stop' }]);
    state = reduce(state, { type: 'status', state: 'cancelled', message: 'Cancelled.' });
    await c.rerender(state);
    expect(c.root.querySelector<HTMLButtonElement>('[aria-label="Stopping…"]')?.disabled).toBe(
      true,
    );
    expect(c.root.querySelector('.stopping-note')?.textContent).toBe('Stopping…');
    state = reduce(state, { type: 'drained' });
    await c.rerender(state);
    expect(c.root.querySelector('[aria-label="Send"]')).not.toBeNull();
  });

  it('Escape in the composer stops a run', async () => {
    const c = mount(reduce(initialState, { type: 'status', state: 'running' }));
    await c.key('Escape');
    expect(c.sent).toEqual([{ type: 'stop' }]);
  });

  it('switches mode and model from the dropdowns, with health and the fallback hint', async () => {
    const state = { ...initialState, models, autoFallback: true };
    const c = mount(state);
    c.root.querySelector<HTMLButtonElement>('[aria-label="Mode: Planning"]')?.click();
    await tick();
    const fast = [...c.root.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('Fast'),
    );
    fast?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(c.sent.at(-1)).toEqual({ type: 'setMode', mode: 'fast' });

    c.root.querySelector<HTMLButtonElement>('[aria-label="Model: Gemini Flash"]')?.click();
    await tick();
    const menu = c.root.querySelector('[role="listbox"][aria-label="Model"]') as HTMLElement;
    expect(menu.textContent).toContain('auto-fallback on');
    expect(menu.querySelector('.health-failed')).not.toBeNull();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(c.sent.at(-1)).toEqual({ type: 'selectModel', name: 'fallback-1' });
  });

  it('lists profiles in order with their roles, plus Other models…', () => {
    const opts = modelOptions(models);
    expect(opts.map((o) => [o.label, o.tag, o.dot])).toEqual([
      ['Gemini Flash', 'primary', 'ok'],
      ['Groq Llama', 'fallback-1', 'failed'],
      ['Other models…', undefined, undefined],
    ]);
  });
});
