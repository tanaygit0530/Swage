import type { BlockState, FileKind, ReviewFile } from '../changeset/changeSet';
import { fileStats, preview } from '../review/model';

/**
 * The change model the agent panel shows (redesign steps 3 and 4): one row per staged file with
 * its +/- counts and decision, and its change blocks with a one-line summary. Built on the host
 * from the task's change set (while staging) or the review session (after submit), so the
 * panel never needs file contents. Works for any number of files and blocks.
 */

export interface ChangeBlockRow {
  readonly id: string;
  readonly state: BlockState;
  readonly added: number;
  readonly removed: number;
  /** 1-based line of the block in the staged preview. */
  readonly line: number;
  readonly summary: string;
}

export type FileDecision = 'pending' | 'accepted' | 'rejected' | 'partial';

export interface ChangeFileRow {
  readonly path: string;
  readonly kind: FileKind;
  readonly added: number;
  readonly removed: number;
  readonly decision: FileDecision;
  readonly blocks: ChangeBlockRow[];
  /** The reason the agent gave in declare_context, if any. */
  readonly reason?: string;
}

const SUMMARY_CHARS = 80;

/** One line about a block: its first added line, else its first removed line. */
export function blockSummary(newLines: readonly string[], oldLines: readonly string[]): string {
  const pick = (lines: readonly string[]): string | undefined =>
    lines.map((l) => l.trim()).find((l) => l.length > 0);
  const added = pick(newLines);
  const text = added ?? pick(oldLines);
  if (text === undefined)
    return newLines.length + oldLines.length > 0 ? 'Blank lines' : 'No change';
  const clipped = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
  return added === undefined ? `Removes: ${clipped}` : clipped;
}

export function fileDecision(states: readonly BlockState[]): FileDecision {
  if (states.length === 0) return 'pending';
  if (states.every((s) => s === 'accepted')) return 'accepted';
  if (states.every((s) => s === 'rejected')) return 'rejected';
  if (states.every((s) => s === 'pending')) return 'pending';
  return 'partial';
}

export function changeRows(
  files: readonly ReviewFile[],
  base: (path: string) => string,
  reasons: ReadonlyMap<string, string> = new Map(),
): ChangeFileRow[] {
  return files
    .map((f): ChangeFileRow => {
      const stats = fileStats(f);
      const starts = new Map(preview(base(f.path), f.blocks).blocks.map((b) => [b.id, b.start]));
      const reason = reasons.get(f.path);
      return {
        path: f.path,
        kind: f.kind,
        added: stats.added,
        removed: stats.removed,
        decision: fileDecision(f.blocks.map((b) => b.state)),
        blocks: f.blocks.map((b) => ({
          id: b.id,
          state: b.state,
          added: b.newLines.length,
          removed: b.oldLines.length,
          line: (starts.get(b.id) ?? b.newStart) + 1,
          summary: blockSummary(b.newLines, b.oldLines),
        })),
        ...(reason ? { reason } : {}),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
