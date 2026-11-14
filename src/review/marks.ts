import type { PreviewBlock } from './model';

/**
 * Where Swage's marks go on the staged side of a diff (review upgrade, step 1), as 0-based
 * inclusive line ranges. Pending blocks: green over added lines, and a red mark on the line
 * where lines were removed. Decided blocks: greyed as accepted or rejected, with a note saying
 * what stays. A decided block that shows no lines (a rejected insertion, an accepted deletion)
 * gets only a note on the line above, so no unrelated line is marked. Every other line is
 * unchanged context, dimmed. Pure, so it is tested without VS Code.
 */

export interface BlockMark {
  /** `note` is text only, for a decided block that shows no lines. */
  readonly kind: 'added' | 'removed' | 'context' | 'accepted' | 'rejected' | 'note';
  readonly start: number;
  readonly end: number;
  /** Text after the line, for example "−3" for three removed lines. */
  readonly note?: string;
}

export function blockMarks(blocks: readonly PreviewBlock[], lineCount: number): BlockMark[] {
  const last = Math.max(0, lineCount - 1);
  const clamp = (n: number): number => Math.min(Math.max(n, 0), last);
  const marks: BlockMark[] = [];
  const changed = new Set<number>();
  for (const b of blocks) {
    if (b.state !== 'pending' && b.end <= b.start) {
      const line = clamp(b.start - 1);
      marks.push({ kind: 'note', start: line, end: line, note: emptyNote(b) });
      continue;
    }
    // A pending block that shows no lines (only removals) marks the line where they were.
    const start = clamp(b.start);
    const end = clamp(Math.max(b.end - 1, b.start));
    for (let l = start; l <= end; l++) changed.add(l);
    if (b.state !== 'pending') {
      const note = b.state === 'accepted' ? '✓ accepted' : '✗ rejected · original kept';
      marks.push({ kind: b.state, start, end, note });
      continue;
    }
    if (b.added > 0) marks.push({ kind: 'added', start, end: clamp(b.start + b.added - 1) });
    if (b.removed > 0)
      marks.push({
        kind: 'removed',
        start,
        end: start,
        note: `−${b.removed} line${b.removed === 1 ? '' : 's'}`,
      });
  }
  if (blocks.length === 0) return marks;
  // Unchanged context, in runs between the blocks.
  let runStart: number | undefined;
  for (let l = 0; l <= last + 1; l++) {
    const isContext = l <= last && !changed.has(l);
    if (isContext && runStart === undefined) runStart = l;
    if (!isContext && runStart !== undefined) {
      marks.push({ kind: 'context', start: runStart, end: l - 1 });
      runStart = undefined;
    }
  }
  return marks;
}

const lines = (n: number): string => (n === 1 ? 'line' : 'lines');

/** The note for a decided block that shows no lines. */
function emptyNote(b: PreviewBlock): string {
  return b.state === 'rejected'
    ? `✗ rejected · ${b.added} added ${lines(b.added)} dropped`
    : `✓ accepted · ${b.removed} ${lines(b.removed)} removed`;
}

/**
 * The change the cursor is on (review upgrade, step 2): the block whose lines hold `line`, else
 * the first block after it, else the last block. Undefined when there are no blocks.
 */
export function blockAtLine<T extends { start: number; end: number }>(
  blocks: readonly T[],
  line: number,
): T | undefined {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  return (
    sorted.find((b) => line >= b.start && line < Math.max(b.end, b.start + 1)) ??
    sorted.find((b) => b.start > line) ??
    sorted.at(-1)
  );
}

/** The next (or previous) change from `line`, wrapping around the file. */
export function neighbourBlock<T extends { start: number; end: number }>(
  blocks: readonly T[],
  line: number,
  direction: 1 | -1,
): T | undefined {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  if (direction === 1) return sorted.find((b) => b.start > line) ?? sorted[0];
  return [...sorted].reverse().find((b) => b.start < line) ?? sorted.at(-1);
}
