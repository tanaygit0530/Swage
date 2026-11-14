import { describe, expect, it } from 'vitest';
import { blockAtLine, blockMarks, neighbourBlock } from '../../../src/review/marks';
import type { PreviewBlock } from '../../../src/review/model';

const block = (over: Partial<PreviewBlock>): PreviewBlock => ({
  id: 'b',
  state: 'pending',
  start: 0,
  end: 0,
  added: 0,
  removed: 0,
  whitespaceOnly: false,
  ...over,
});

describe('block marks on the staged side', () => {
  it('marks added lines green, removals red with a count, and dims the rest', () => {
    const marks = blockMarks(
      [
        block({ id: 'b1', start: 2, end: 4, added: 2, removed: 1 }),
        block({ id: 'b2', start: 7, end: 7, added: 0, removed: 3 }),
      ],
      10,
    );
    expect(marks).toEqual([
      { kind: 'added', start: 2, end: 3 },
      { kind: 'removed', start: 2, end: 2, note: '−1 line' },
      { kind: 'removed', start: 7, end: 7, note: '−3 lines' },
      { kind: 'context', start: 0, end: 1 },
      { kind: 'context', start: 4, end: 6 },
      { kind: 'context', start: 8, end: 9 },
    ]);
  });

  it('greys decided blocks and keeps marks inside the document', () => {
    const marks = blockMarks(
      [
        block({ id: 'a', state: 'accepted', start: 0, end: 2, added: 2 }),
        block({ id: 'r', state: 'rejected', start: 5, end: 9, removed: 4 }),
      ],
      6,
    );
    expect(marks.filter((m) => m.kind !== 'context')).toEqual([
      { kind: 'accepted', start: 0, end: 1, note: '✓ accepted' },
      { kind: 'rejected', start: 5, end: 5, note: '✗ rejected · original kept' },
    ]);
  });

  it('notes a decided block that shows no lines on the line above, leaving the next line alone', () => {
    // A rejected insertion (its added lines are dropped) and an accepted deletion show no lines.
    const marks = blockMarks(
      [
        block({ id: 'r', state: 'rejected', start: 3, end: 3, added: 2 }),
        block({ id: 'a', state: 'accepted', start: 6, end: 6, removed: 1 }),
      ],
      10,
    );
    expect(marks).toEqual([
      { kind: 'note', start: 2, end: 2, note: '✗ rejected · 2 added lines dropped' },
      { kind: 'note', start: 5, end: 5, note: '✓ accepted · 1 line removed' },
      { kind: 'context', start: 0, end: 9 },
    ]);
    // At the top of the file the note goes on the first line.
    expect(
      blockMarks([block({ state: 'rejected', start: 0, end: 0, added: 1 })], 4).filter(
        (m) => m.kind === 'note',
      ),
    ).toEqual([{ kind: 'note', start: 0, end: 0, note: '✗ rejected · 1 added line dropped' }]);
  });

  it('marks a new file all green and an emptied file on its only line, with no context', () => {
    expect(blockMarks([block({ start: 0, end: 3, added: 3 })], 3)).toEqual([
      { kind: 'added', start: 0, end: 2 },
    ]);
    expect(blockMarks([block({ start: 0, end: 0, removed: 5 })], 1)).toEqual([
      { kind: 'removed', start: 0, end: 0, note: '−5 lines' },
    ]);
    expect(blockMarks([], 5)).toEqual([]);
  });
});

describe('the focused change', () => {
  const blocks = [
    { id: 'a', start: 2, end: 4 },
    { id: 'b', start: 8, end: 8 },
    { id: 'c', start: 12, end: 15 },
  ];
  it('is the block under the cursor, else the next one, else the last', () => {
    expect(blockAtLine(blocks, 3)?.id).toBe('a');
    expect(blockAtLine(blocks, 8)?.id).toBe('b');
    expect(blockAtLine(blocks, 5)?.id).toBe('b');
    expect(blockAtLine(blocks, 20)?.id).toBe('c');
    expect(blockAtLine([], 0)).toBeUndefined();
  });

  it('moves to the next and previous change, wrapping', () => {
    expect(neighbourBlock(blocks, 3, 1)?.id).toBe('b');
    expect(neighbourBlock(blocks, 12, 1)?.id).toBe('a');
    expect(neighbourBlock(blocks, 8, -1)?.id).toBe('a');
    expect(neighbourBlock(blocks, 2, -1)?.id).toBe('c');
    expect(neighbourBlock([], 0, 1)).toBeUndefined();
  });
});
