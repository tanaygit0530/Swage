// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebviewToHost } from '../../../src/ui/protocol';
import { Markdown } from '../../../src/ui/webview/richText';

function mount(text: string): { root: HTMLElement; sent: WebviewToHost[] } {
  const root = document.createElement('div');
  document.body.append(root);
  const sent: WebviewToHost[] = [];
  render(<Markdown text={text} send={(m) => sent.push(m)} />, root);
  return { root, sent };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('rendered Markdown', () => {
  it('shows HTML from the model as text, never as elements', () => {
    const { root } = mount('<script>alert(1)</script><img src=x onerror=alert(2)>');
    expect(root.querySelector('script, img')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders headings, lists, tables and links', () => {
    const { root } = mount(
      '### Files\n\n1. one\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[site](https://example.com)',
    );
    expect(root.querySelector('h5')?.textContent).toBe('Files');
    expect(root.querySelectorAll('ol > li')).toHaveLength(2);
    expect(root.querySelectorAll('td')).toHaveLength(2);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('opens files and symbols from chips', () => {
    const { root, sent } = mount('Edit `flask/cli.py:12` then call `get_debug_flag()`.');
    const [file, symbol] = [...root.querySelectorAll<HTMLButtonElement>('button.chip')];
    file?.click();
    symbol?.click();
    expect(sent).toEqual([
      { type: 'openFile', path: 'flask/cli.py', line: 12 },
      { type: 'openSymbol', name: 'get_debug_flag' },
    ]);
    expect(file?.getAttribute('aria-label')).toBe('Open flask/cli.py:12');
  });

  it('gives code blocks a language header with Insert and Copy', () => {
    vi.useFakeTimers();
    const { root, sent } = mount('```bash\npip install -r requirements.txt\n```');
    expect(root.querySelector('.codeblock-lang')?.textContent).toBe('bash');
    const insert = root.querySelector<HTMLButtonElement>('[aria-label="Insert at cursor"]');
    const copy = root.querySelector<HTMLButtonElement>('[aria-label="Copy code"]');
    insert?.click();
    copy?.click();
    expect(sent).toEqual([
      { type: 'insertCode', text: 'pip install -r requirements.txt' },
      { type: 'copy', text: 'pip install -r requirements.txt' },
    ]);
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('disables Insert while the block is still streaming', () => {
    const { root } = mount('```py\nprint(1)');
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Insert at cursor"]')?.disabled).toBe(
      true,
    );
  });
});
