import type { ChangeFile } from '../protocol';
import type { PanelState, TimelineItem } from './state';

/**
 * The files-changed bar's view model (redesign step 4): rows ordered by path, totals, which
 * files the agent is editing right now (a running stage_edit), and whether decisions are
 * possible yet (only once the change set is submitted). Never assumes a file or block count.
 */

export interface BarRow extends ChangeFile {
  /** A stage_edit on this file is running. */
  readonly editing: boolean;
}

export interface BarModel {
  readonly visible: boolean;
  readonly phase: PanelState['changes']['phase'];
  readonly rows: readonly BarRow[];
  readonly files: number;
  /** Files not applied or discarded yet (the count the footer shows). */
  readonly open: number;
  readonly added: number;
  readonly removed: number;
  readonly blocks: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly pending: number;
  /** Accept and reject buttons work (the change set is in review). */
  readonly canDecide: boolean;
  /** Some blocks are accepted: "Apply accepted" applies just those. */
  readonly canApplyAccepted: boolean;
}

/** Paths of stage_edit calls still running, from the timeline. */
export function editingPaths(timeline: readonly TimelineItem[]): Set<string> {
  const out = new Set<string>();
  for (const t of timeline) {
    if (t.kind !== 'tool' || t.name !== 'stage_edit' || t.status !== 'running') continue;
    const path = t.summary.replace(/^(edit|write|delete)\s+/, '').trim();
    if (path) out.add(path);
  }
  return out;
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function barModel(state: Pick<PanelState, 'changes' | 'timeline'>): BarModel {
  const { phase, files } = state.changes;
  const editing = phase === 'review' ? new Set<string>() : editingPaths(state.timeline);
  const rows: BarRow[] = files.map((f) => ({ ...f, editing: editing.has(f.path) }));
  // A file whose first stage_edit is still running has no row yet: show it with a spinner.
  for (const path of editing) {
    if (!rows.some((r) => r.path === path))
      rows.push({
        path,
        kind: 'modify',
        added: 0,
        removed: 0,
        decision: 'pending',
        blocks: [],
        editing: true,
      });
  }
  rows.sort(byPath);
  let blocks = 0;
  let accepted = 0;
  let rejected = 0;
  for (const r of rows.filter((x) => !x.settled))
    for (const b of r.blocks) {
      blocks++;
      if (b.state === 'accepted') accepted++;
      else if (b.state === 'rejected') rejected++;
    }
  return {
    visible: rows.length > 0 && phase !== 'none',
    phase,
    rows,
    files: rows.length,
    open: rows.filter((r) => !r.settled).length,
    added: rows.reduce((n, r) => n + r.added, 0),
    removed: rows.reduce((n, r) => n + r.removed, 0),
    blocks,
    accepted,
    rejected,
    pending: blocks - accepted - rejected,
    canDecide: phase === 'review',
    canApplyAccepted: phase === 'review' && accepted > 0 && accepted < blocks,
  };
}

/** "N Files With Changes", with the right plural. */
export function barTitle(files: number): string {
  return `${files} File${files === 1 ? '' : 's'} With Changes`;
}

/** Created files, numbered, for the walkthrough's "Created files" list. */
export function createdFiles<T extends { kind: string; path: string }>(files: readonly T[]): T[] {
  return files.filter((f) => f.kind === 'create').sort(byPath);
}
