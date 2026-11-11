import type { ChangeSet, ChangeSetResult, ReviewFile } from '../changeset/changeSet';
import { preview, totals, type Preview } from './model';

/**
 * One change set under review. Wraps the task's ChangeSet and notifies listeners on every
 * decision, so the diff, CodeLens, decorations and tree update live. No VS Code dependency.
 */
export class ReviewSession {
  private readonly listeners = new Set<(paths: readonly string[]) => void>();

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

  result(): ChangeSetResult {
    return this.changeSet.result();
  }
}
