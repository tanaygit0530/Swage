import { diffArrays } from 'diff';
import { joinLines, splitLines } from './text';

/**
 * A change block: a maximal run of changed lines with zero context (blueprint section 8).
 * Lines keep their terminators, so CRLF and a missing final newline survive untouched.
 * A diff may yield zero, one or many blocks; callers must never assume a count.
 */
export interface Block {
  /** Unique within a file. Split parts get `<parent>.<n>`. */
  readonly id: string;
  /** Zero-based index of the first replaced line in the old text. */
  readonly oldStart: number;
  readonly oldLines: readonly string[];
  /** Zero-based index of the first line in the new text. Also orders insertions at the same spot. */
  readonly newStart: number;
  readonly newLines: readonly string[];
  /** True when the block only changes whitespace. */
  readonly whitespaceOnly: boolean;
}

function isWhitespaceOnly(oldLines: readonly string[], newLines: readonly string[]): boolean {
  const a = joinLines(oldLines);
  const b = joinLines(newLines);
  return a !== b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

function makeBlock(
  id: string,
  oldStart: number,
  oldLines: readonly string[],
  newStart: number,
  newLines: readonly string[],
): Block {
  return {
    id,
    oldStart,
    oldLines,
    newStart,
    newLines,
    whitespaceOnly: isWhitespaceOnly(oldLines, newLines),
  };
}

/**
 * Computes the change blocks that turn `before` into `after`.
 * @param idPrefix optional prefix, usually the file path, giving ids like `src/a.py#1`.
 */
export function computeBlocks(before: string, after: string, idPrefix?: string): Block[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const changes = diffArrays(oldLines, newLines);

  const blocks: Block[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let pending: { oldStart: number; newStart: number; old: string[]; new: string[] } | undefined;

  const flush = (): void => {
    if (!pending) return;
    const n = blocks.length + 1;
    const id = idPrefix === undefined ? String(n) : `${idPrefix}#${n}`;
    blocks.push(makeBlock(id, pending.oldStart, pending.old, pending.newStart, pending.new));
    pending = undefined;
  };

  for (const change of changes) {
    const value = change.value;
    if (!change.added && !change.removed) {
      flush();
      oldIdx += value.length;
      newIdx += value.length;
      continue;
    }
    pending ??= { oldStart: oldIdx, newStart: newIdx, old: [], new: [] };
    if (change.removed) {
      pending.old.push(...value);
      oldIdx += value.length;
    } else {
      pending.new.push(...value);
      newIdx += value.length;
    }
  }
  flush();
  return blocks;
}

function sameLines(base: readonly string[], start: number, lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (base[start + i] !== lines[i]) return false;
  }
  return true;
}

/**
 * Applies only the accepted blocks to `base`. Rejected blocks keep the old lines.
 * Blocks may be given in any order; they must not overlap in the old text.
 */
export function applyBlocks(
  base: string,
  blocks: readonly Block[],
  acceptedIds: Iterable<string>,
): string {
  const accepted = new Set(acceptedIds);
  const known = new Set(blocks.map((b) => b.id));
  for (const id of accepted) {
    if (!known.has(id)) throw new Error(`unknown block id: ${id}`);
  }

  const lines = splitLines(base);
  const ordered = [...blocks].sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart);
  const out: string[] = [];
  let cursor = 0;

  for (const block of ordered) {
    if (block.oldStart < cursor || !sameLines(lines, block.oldStart, block.oldLines)) {
      throw new Error(`block ${block.id} does not match the base text`);
    }
    out.push(...lines.slice(cursor, block.oldStart));
    out.push(...(accepted.has(block.id) ? block.newLines : block.oldLines));
    cursor = block.oldStart + block.oldLines.length;
  }
  if (cursor > lines.length) throw new Error('blocks do not match the base text');
  out.push(...lines.slice(cursor));
  return joinLines(out);
}

/**
 * Splits a block in two: the first `oldOffset` old lines are replaced by the first
 * `newOffset` new lines, and the rest by the rest. Both parts must be non-empty.
 */
export function splitBlock(block: Block, oldOffset: number, newOffset: number): [Block, Block] {
  const oldLen = block.oldLines.length;
  const newLen = block.newLines.length;
  if (oldOffset < 0 || oldOffset > oldLen || newOffset < 0 || newOffset > newLen) {
    throw new Error(`split offsets out of range for block ${block.id}`);
  }
  if ((oldOffset === 0 && newOffset === 0) || (oldOffset === oldLen && newOffset === newLen)) {
    throw new Error(`split of block ${block.id} would leave an empty part`);
  }
  return [
    makeBlock(
      `${block.id}.1`,
      block.oldStart,
      block.oldLines.slice(0, oldOffset),
      block.newStart,
      block.newLines.slice(0, newOffset),
    ),
    makeBlock(
      `${block.id}.2`,
      block.oldStart + oldOffset,
      block.oldLines.slice(oldOffset),
      block.newStart + newOffset,
      block.newLines.slice(newOffset),
    ),
  ];
}

/**
 * Splits a block into line-sized parts by pairing the n-th old line with the n-th new line.
 * Extra old lines become deletions and extra new lines become insertions.
 * A block with at most one line on each side is returned unchanged.
 */
export function splitBlockByLine(block: Block): Block[] {
  const oldLen = block.oldLines.length;
  const newLen = block.newLines.length;
  if (oldLen <= 1 && newLen <= 1) return [block];

  const parts: Block[] = [];
  const count = Math.max(oldLen, newLen);
  for (let i = 0; i < count; i++) {
    const oldLine = block.oldLines[i];
    const newLine = block.newLines[i];
    parts.push(
      makeBlock(
        `${block.id}.${i + 1}`,
        block.oldStart + Math.min(i, oldLen),
        oldLine === undefined ? [] : [oldLine],
        block.newStart + Math.min(i, newLen),
        newLine === undefined ? [] : [newLine],
      ),
    );
  }
  return parts;
}
