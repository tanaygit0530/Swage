import type { FileChange } from './changeSet';
import { hashText } from './text';

/**
 * Atomic apply and checkpoint undo (blueprint section 8). All disk access goes through
 * an injected file system, so this module runs without VS Code. Content is written
 * verbatim: line endings and final newlines were already fixed by the change set.
 */

export interface WorkspaceFs {
  /** Current content, or `undefined` when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Writes the file, creating parent folders as needed. */
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface CheckpointEntry {
  readonly path: string;
  /** Content before apply; `undefined` if the file was created by the apply. */
  readonly before: string | undefined;
  /** Hash after apply; `undefined` if the apply deleted the file. */
  readonly afterHash: string | undefined;
}

export interface Checkpoint {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly entries: readonly CheckpointEntry[];
}

export type ConflictReason = 'changed_on_disk' | 'missing' | 'already_exists';

export interface Conflict {
  readonly path: string;
  readonly reason: ConflictReason;
}

export type ApplyError =
  | { readonly code: 'nothing_to_apply'; readonly message: string }
  | { readonly code: 'duplicate_path'; readonly path: string; readonly message: string }
  | { readonly code: 'conflict'; readonly conflicts: readonly Conflict[]; readonly message: string }
  | {
      readonly code: 'write_failed';
      readonly path: string;
      readonly rolledBack: boolean;
      readonly message: string;
    };

export type UndoError =
  | { readonly code: 'nothing_to_undo'; readonly message: string }
  | { readonly code: 'conflict'; readonly conflicts: readonly Conflict[]; readonly message: string }
  | {
      readonly code: 'write_failed';
      readonly path: string;
      readonly rolledBack: boolean;
      readonly message: string;
    };

export type ApplyResult =
  | { readonly ok: true; readonly checkpoint: Checkpoint }
  | { readonly ok: false; readonly error: ApplyError };

export type UndoResult =
  | { readonly ok: true; readonly checkpoint: Checkpoint }
  | { readonly ok: false; readonly error: UndoError };

export interface ApplierOptions {
  /** How many applied change sets can be undone. Defaults to 2. */
  readonly maxUndo?: number;
  /** Restored history, for example from globalStorage after a window reload. */
  readonly history?: readonly Checkpoint[];
  readonly now?: () => number;
}

interface Planned {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

function describeConflicts(conflicts: readonly Conflict[]): string {
  return conflicts.map((c) => `${c.path} (${c.reason.replace(/_/g, ' ')})`).join(', ');
}

export class Applier {
  private readonly maxUndo: number;
  private readonly now: () => number;
  private readonly stack: Checkpoint[];
  private counter = 0;

  constructor(
    private readonly fs: WorkspaceFs,
    options: ApplierOptions = {},
  ) {
    this.maxUndo = Math.max(1, options.maxUndo ?? 2);
    this.now = options.now ?? Date.now;
    this.stack = [...(options.history ?? [])].slice(-this.maxUndo);
  }

  /** Checkpoints that can still be undone, oldest first. Persist this to survive reloads. */
  get history(): readonly Checkpoint[] {
    return [...this.stack];
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Applies every change or none. Each file's current hash must equal its base hash
   * from staging; otherwise nothing is written and the conflicts are reported.
   */
  async apply(taskId: string, changes: readonly FileChange[]): Promise<ApplyResult> {
    if (changes.length === 0) {
      return {
        ok: false,
        error: { code: 'nothing_to_apply', message: 'No accepted changes to apply.' },
      };
    }
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.path)) {
        return {
          ok: false,
          error: {
            code: 'duplicate_path',
            path: c.path,
            message: `${c.path} appears twice in one apply.`,
          },
        };
      }
      seen.add(c.path);
    }

    const conflicts: Conflict[] = [];
    const plan: Planned[] = [];
    for (const change of changes) {
      const current = await this.fs.read(change.path);
      if (change.op === 'create') {
        if (current !== undefined) conflicts.push({ path: change.path, reason: 'already_exists' });
        plan.push({ path: change.path, before: undefined, after: change.content });
        continue;
      }
      if (current === undefined) {
        conflicts.push({ path: change.path, reason: 'missing' });
      } else if (hashText(current) !== change.baseHash) {
        conflicts.push({ path: change.path, reason: 'changed_on_disk' });
      }
      plan.push({
        path: change.path,
        before: current,
        after: change.op === 'delete' ? undefined : change.content,
      });
    }

    if (conflicts.length > 0) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          conflicts,
          message: `Not applied: these files changed since staging: ${describeConflicts(conflicts)}. Re-stage them against the current content.`,
        },
      };
    }

    const failure = await this.writeAll(
      plan.map((p) => ({ path: p.path, from: p.before, to: p.after })),
    );
    if (failure) return { ok: false, error: failure };

    const checkpoint: Checkpoint = {
      id: `cp-${this.now()}-${++this.counter}`,
      taskId,
      createdAt: this.now(),
      entries: plan.map((p) => ({
        path: p.path,
        before: p.before,
        afterHash: p.after === undefined ? undefined : hashText(p.after),
      })),
    };
    this.stack.push(checkpoint);
    while (this.stack.length > this.maxUndo) this.stack.shift();
    return { ok: true, checkpoint };
  }

  /**
   * Restores the most recent checkpoint. Refuses if a file changed after apply,
   * unless `force` is set because the user confirmed overwriting those changes.
   */
  async undo(options: { force?: boolean } = {}): Promise<UndoResult> {
    const checkpoint = this.stack.at(-1);
    if (!checkpoint) {
      return {
        ok: false,
        error: { code: 'nothing_to_undo', message: 'There is no applied change set to undo.' },
      };
    }

    const conflicts: Conflict[] = [];
    const steps: { path: string; from: string | undefined; to: string | undefined }[] = [];
    for (const entry of checkpoint.entries) {
      const current = await this.fs.read(entry.path);
      const currentHash = current === undefined ? undefined : hashText(current);
      if (currentHash !== entry.afterHash) {
        conflicts.push({
          path: entry.path,
          reason:
            current === undefined
              ? 'missing'
              : entry.afterHash === undefined
                ? 'already_exists'
                : 'changed_on_disk',
        });
      }
      steps.push({ path: entry.path, from: current, to: entry.before });
    }

    if (conflicts.length > 0 && options.force !== true) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          conflicts,
          message: `These files changed after the apply: ${describeConflicts(conflicts)}. Undo again with force to overwrite them.`,
        },
      };
    }

    const failure = await this.writeAll(steps);
    if (failure) return { ok: false, error: failure };
    this.stack.pop();
    return { ok: true, checkpoint };
  }

  /** Writes every step; on a failure, restores the steps already written. */
  private async writeAll(
    steps: readonly { path: string; from: string | undefined; to: string | undefined }[],
  ): Promise<Extract<ApplyError, { code: 'write_failed' }> | undefined> {
    const done: (typeof steps)[number][] = [];
    for (const step of steps) {
      try {
        await this.put(step.path, step.to);
        done.push(step);
      } catch (err) {
        let rolledBack = true;
        for (const prev of [...done].reverse()) {
          try {
            await this.put(prev.path, prev.from);
          } catch {
            rolledBack = false;
          }
        }
        return {
          code: 'write_failed',
          path: step.path,
          rolledBack,
          message: `Could not write ${step.path}: ${(err as Error).message}. ${
            rolledBack
              ? 'Earlier files were restored.'
              : 'Some earlier files could not be restored.'
          }`,
        };
      }
    }
    return undefined;
  }

  private async put(path: string, content: string | undefined): Promise<void> {
    if (content === undefined) await this.fs.remove(path);
    else await this.fs.write(path, content);
  }
}
