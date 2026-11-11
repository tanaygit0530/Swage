import type { Block } from '../changeset/blocks';
import type { EditableRange } from './context';

/**
 * Range lock (blueprint F13): an inline edit may change only the selected lines. Blocks that
 * touch other lines, or other files, are not refused; they are flagged in the tool result so
 * the model can fix them, and in the review so the user sees them before accepting.
 */

/**
 * True when a block lies inside the 1-based, inclusive range. A pure insertion is inside when it
 * lands between the first line and the line after the last one.
 */
export function blockInRange(block: Block, range: EditableRange): boolean {
  const first = range.startLine - 1;
  const after = range.endLine;
  if (block.oldLines.length === 0) return block.oldStart >= first && block.oldStart <= after;
  return block.oldStart >= first && block.oldStart + block.oldLines.length <= after;
}

/** Ids of the blocks of one file that fall outside the editable range. */
export function blocksOutside(
  path: string,
  blocks: readonly Block[],
  range: EditableRange | undefined,
): string[] {
  if (!range) return [];
  if (path !== range.path) return blocks.map((b) => b.id);
  return blocks.filter((b) => !blockInRange(b, range)).map((b) => b.id);
}

/** A warning for the tool result, or undefined when every block is inside the range. */
export function rangeWarning(
  path: string,
  blocks: readonly Block[],
  range: EditableRange | undefined,
): string | undefined {
  const outside = blocksOutside(path, blocks, range);
  if (!range || outside.length === 0) return undefined;
  if (path !== range.path)
    return `${path} is outside the inline edit; only ${range.path} lines ${range.startLine}-${range.endLine} may change. The user will see it flagged.`;
  return `${outside.length} block(s) change lines outside ${range.path} ${range.startLine}-${range.endLine}; the user will see them flagged. Keep edits inside the selection.`;
}
