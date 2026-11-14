import type { ChangeSet, ChangeSetResult, FileChange, ReviewFile } from '../changeset/changeSet';
import { preview, totals, type Preview } from './model';

/**
 * One change set under review. Wraps the task's ChangeSet and notifies listeners on every
 * decision, so the diff, CodeLens, decorations and tree update live. No VS Code dependency.
 */
/** Where a file stands in an agent-mode review (redesign of the review, step 3). */
export type FileReviewStatus =
  'pending' | 'partial' | 'accepted' | 'rejected' | 'applied' | 'discarded';

export class ReviewSession {
  private readonly listeners = new Set<(paths: readonly string[]) => void>();
  /** Files already settled one at a time: applied to disk, or discarded. */
  private readonly done = new Map<string, 'applied' | 'discarded'>();

  constructor(
    readonly taskId: string,
    readonly changeSet: ChangeSet,
  ) {}

  onDidChange(listener: (paths: readonly string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(paths: readonly string[]): void {
    for (const l of this.listeners) l(paths);
  }

  files(): ReviewFile[] {
    return this.changeSet.review();
  }

  file(path: string): ReviewFile | undefined {
    return this.files().find((f) => f.path === path);
  }

  base(path: string): string {
    return this.changeSet.base(path) ?? '';
  }

  preview(path: string): Preview {
    const file = this.file(path);
    return preview(this.base(path), file?.blocks ?? []);
  }

  totals(): ReturnType<typeof totals> {
    return totals(this.files());
  }

  accept(path: string, blockId: string): boolean {
    const ok = this.changeSet.accept(path, blockId).ok;
    if (ok) this.changed([path]);
    return ok;
  }

  reject(path: string, blockId: string): boolean {
    const ok = this.changeSet.reject(path, blockId).ok;
    if (ok) this.changed([path]);
    return ok;
  }

  /** Splits a block into line-sized parts (blueprint section 8: a split handles a block that merges too much). */
  split(path: string, blockId: string): string[] {
    const r = this.changeSet.split(path, blockId);
    if (!r.ok) return [];
    this.changed([path]);
    return r.value;
  }

  acceptFile(path: string): void {
    this.changeSet.acceptAll(path);
    this.changed([path]);
  }

  rejectFile(path: string): void {
    this.changeSet.rejectAll(path);
    this.changed([path]);
  }

  acceptAll(): void {
    this.changeSet.acceptAll();
    this.changed(this.files().map((f) => f.path));
  }

  rejectAll(): void {
    this.changeSet.rejectAll();
    this.changed(this.files().map((f) => f.path));
  }

  /** Re-stages files against new base content after a conflict. */
  rebase(bases: ReadonlyMap<string, string | undefined>): void {
    for (const [p, content] of bases) this.changeSet.rebase(p, content);
    this.changed([...bases.keys()]);
  }

  /** The whole change set's decisions, without the files already applied or discarded. */
  result(): ChangeSetResult {
    const r = this.changeSet.result();
    if (this.done.size === 0) return r;
    const open = this.files().filter((f) => !this.done.has(f.path));
    const openPaths = new Set(open.map((f) => f.path));
    const ids = (state: 'accepted' | 'rejected' | 'pending'): string[] =>
      open.flatMap((f) => f.blocks.filter((b) => b.state === state).map((b) => b.id));
    return {
      changes: r.changes.filter((c) => openPaths.has(c.path)),
      accepted: ids('accepted'),
      rejected: ids('rejected'),
      pending: ids('pending'),
    };
  }

  /** The status of one file, for the bar, the tree and the per-file controls. */
  status(path: string): FileReviewStatus {
    const settled = this.done.get(path);
    if (settled) return settled;
    const states = this.file(path)?.blocks.map((b) => b.state) ?? [];
    if (states.length === 0 || states.every((s) => s === 'pending')) return 'pending';
    if (states.every((s) => s === 'accepted')) return 'accepted';
    if (states.every((s) => s === 'rejected')) return 'rejected';
    return 'partial';
  }

  /** Files not yet applied or discarded, in path order (the order of the bar and the tree). */
  openFiles(): string[] {
    return this.files()
      .map((f) => f.path)
      .filter((p) => !this.done.has(p))
      .sort();
  }

  /** The file to review after `path`: the next open file in path order, wrapping around. */
  nextOpen(path?: string): string | undefined {
    const open = this.openFiles();
    if (open.length === 0) return undefined;
    if (path === undefined) return open[0];
    return open.find((p) => p > path) ?? open.find((p) => p !== path) ?? undefined;
  }

  /** The open file before `path` in path order, wrapping around. */
  previousOpen(path: string): string | undefined {
    const open = this.openFiles();
    return [...open].reverse().find((p) => p < path) ?? open.filter((p) => p !== path).at(-1);
  }

  /**
   * "Accept file": every block of the file not decided yet is accepted; rejected blocks stay
   * rejected, so a partly reviewed file applies exactly its accepted blocks. Returns that file's
   * change, or undefined when nothing of it is accepted (it is then discarded).
   */
  acceptForApply(path: string): FileChange | undefined {
    for (const b of this.file(path)?.blocks ?? [])
      if (b.state === 'pending') this.changeSet.accept(path, b.id);
    this.changed([path]);
    return this.changeSet.result().changes.find((c) => c.path === path);
  }

  /** Records that a file was applied to disk or discarded; it leaves the open list. */
  settle(path: string, how: 'applied' | 'discarded'): void {
    if (how === 'discarded') this.changeSet.rejectAll(path);
    this.done.set(path, how);
    this.changed([path]);
  }

  /** True once every file was applied or discarded one at a time. */
  get allSettled(): boolean {
    return this.files().length > 0 && this.openFiles().length === 0;
  }

  /** Files applied one at a time in this review. */
  get applied(): string[] {
    return [...this.done].filter(([, how]) => how === 'applied').map(([p]) => p);
  }
}
