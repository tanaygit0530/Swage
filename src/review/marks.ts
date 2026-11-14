import type { PreviewBlock } from './model';

/**
 * Where Swage's marks go on the staged side of a diff (review upgrade, step 1), as 0-based
 * inclusive line ranges. Pending blocks: green over added lines, and a red mark on the line
 * where lines were removed. Decided blocks: greyed as accepted or rejected. Every other line is
 * unchanged context, dimmed. Pure, so it is tested without VS Code.
 */

export interface BlockMark {
  readonly kind: 'added' | 'removed' | 'context' | 'accepted' | 'rejected';
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
    // A block that shows no lines (only removals, or an accepted deletion) marks the line where it was.
    const start = clamp(b.start);
    const end = clamp(Math.max(b.end - 1, b.start));
    for (let l = start; l <= end; l++) changed.add(l);
    if (b.state !== 'pending') {
      marks.push({ kind: b.state, start, end });
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
