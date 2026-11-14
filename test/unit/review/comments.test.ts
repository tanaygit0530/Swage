import { describe, expect, it } from 'vitest';
import { CommentQueue, formatComments } from '../../../src/review/comments';

describe('review comments for the agent', () => {
  it('queues comments, ignores empty ones, and notifies', () => {
    const q = new CommentQueue();
    let changes = 0;
    q.onDidChange(() => changes++);
    expect(
      q.add({ path: 'a.py', startLine: 3, endLine: 1, quote: 'x', text: '   ' }),
    ).toBeUndefined();
    const c = q.add({
      path: 'a.py',
      startLine: 3,
      endLine: 1,
      quote: 'x = 1\n',
      text: ' use a constant ',
    });
    expect(c).toMatchObject({ id: 'c1', startLine: 1, endLine: 3, text: 'use a constant' });
    q.add({ path: 'b.py', startLine: 7, endLine: 7, quote: 'y', text: 'rename' });
    expect(q.all).toHaveLength(2);
    expect(q.remove('c1')).toBe(true);
    expect(q.remove('c1')).toBe(false);
    expect(changes).toBe(3);
  });

  it('attaches file, lines, quoted code and text to the next request, then clears', () => {
    const q = new CommentQueue();
    expect(q.attach('Fix it')).toBe('Fix it');
    q.add({
      path: 'src/cli.py',
      startLine: 10,
      endLine: 12,
      quote: 'def a():\n    pass\n',
      text: 'add a docstring',
    });
    q.add({ path: 'src/cli.py', startLine: 20, endLine: 20, quote: 'x = 2', text: 'why 2?' });
    const sent = q.attach('Please address my comments.');
    expect(sent).toMatch(/^Please address my comments\.\n\nReview comments from the user/);
    expect(sent).toContain('- src/cli.py lines 10-12: add a docstring');
    expect(sent).toContain(
      '  <<<CODE src/cli.py lines 10-12>>>\n  def a():\n      pass\n  <<<END CODE>>>',
    );
    expect(sent).toContain('- src/cli.py line 20: why 2?');
    expect(q.all).toHaveLength(0);
  });

  it('redacts secrets and shortens long quotes', () => {
    const key = ['sk', 'abcdefghijklmnop', 'qrstuvwx1234'].join('-');
    const text = formatComments([
      {
        id: 'c1',
        path: 'cfg.py',
        startLine: 1,
        endLine: 30,
        quote: `API_KEY = "${key}"\n${'line\n'.repeat(29)}`,
        text: `do not commit ${key}`,
      },
    ]);
    expect(text).not.toContain(key);
    expect(text).toContain('… (10 more lines)');
  });
});
