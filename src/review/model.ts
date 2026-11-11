import { applyBlocks } from '../changeset/blocks';
import type { BlockState, ReviewBlock, ReviewFile } from '../changeset/changeSet';

/**
 * Pure review model (blueprint section 8): what the right side of the diff shows and where each
 * block sits in it. The preview is the base with every block that is not rejected applied, so a
 * rejected block drops out of the diff at once and comes back if it is accepted again. Works for
 * any number of blocks, including zero (a delete of an empty file) and many.
 */

export interface PreviewBlock {
  readonly id: string;
  readonly state: BlockState;
  /** 0-based first line of the block in the preview content. */
  readonly start: number;
  /** 0-based line after the block's lines in the preview (start when the block shows no lines). */
  readonly end: number;
  readonly added: number;
  readonly removed: number;
  readonly whitespaceOnly: boolean;
}

export interface Preview {
  readonly content: string;
  readonly blocks: readonly PreviewBlock[];
}

export function preview(base: string, blocks: readonly ReviewBlock[]): Preview {
  const shown = blocks.filter((b) => b.state !== 'rejected').map((b) => b.id);
  const content = applyBlocks(base, blocks, shown);
  const ordered = [...blocks].sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart);
  let delta = 0;
  const out: PreviewBlock[] = [];
  for (const b of ordered) {
    const start = b.oldStart + delta;
    const included = b.state !== 'rejected';
    const lines = included ? b.newLines.length : b.oldLines.length;
    out.push({
      id: b.id,
      state: b.state,
      start,
      end: start + lines,
      added: b.newLines.length,
      removed: b.oldLines.length,
      whitespaceOnly: b.whitespaceOnly,
    });
    if (included) delta += b.newLines.length - b.oldLines.length;
  }
  return { content, blocks: out };
}

export interface FileStats {
  readonly blocks: number;
  readonly added: number;
  readonly removed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly pending: number;
}

export function fileStats(file: ReviewFile): FileStats {
  let added = 0;
  let removed = 0;
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  for (const b of file.blocks) {
    added += b.newLines.length;
    removed += b.oldLines.length;
    counts[b.state]++;
  }
  return { blocks: file.blocks.length, added, removed, ...counts };
}

export function totals(files: readonly ReviewFile[]): FileStats & { files: number } {
  const all = files.map(fileStats);
  const sum = (k: keyof FileStats): number => all.reduce((n, s) => n + s[k], 0);
  return {
    files: files.length,
    blocks: sum('blocks'),
    added: sum('added'),
    removed: sum('removed'),
    accepted: sum('accepted'),
    rejected: sum('rejected'),
    pending: sum('pending'),
  };
}

/** "+3 -1 · 2 blocks (1 accepted, 1 pending)" for tree items and titles. */
export function describeStats(s: FileStats): string {
  const parts = [
    s.accepted ? `${s.accepted} accepted` : '',
    s.rejected ? `${s.rejected} rejected` : '',
    s.pending ? `${s.pending} pending` : '',
  ].filter(Boolean);
  return `+${s.added} -${s.removed} · ${s.blocks} block${s.blocks === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
