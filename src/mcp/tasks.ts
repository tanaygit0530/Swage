import { createHash } from 'node:crypto';
import { ChangeSet, type FileReader } from '../changeset/changeSet';
import { ReadBudget } from '../context/budget';
import type { EditableRange } from '../inline/context';

/**
 * Tasks own the per-run state the tools share (blueprint section 8): the change set, the
 * read budget, and an abort signal. A task is keyed by Swage's task id, not a TrueForge
 * session id, and records the current TrueForge turn id so late tool results from a
 * cancelled or superseded turn can be ignored.
 */

export interface Task {
  readonly id: string;
  /** TrueForge turn id the task is currently running, if known. */
  turnId: string | undefined;
  readonly changeSet: ChangeSet;
  readonly readBudget: ReadBudget;
  readonly controller: AbortController;
  cancelled: boolean;
  /** First submit_change_set result; a repeated call returns it unchanged. */
  submission?: string;
  /** Inline edits only: the lines the agent may change (blueprint F13, range lock). */
  editableRange?: EditableRange;
  /** The last run_tests: on which staged state, and whether it passed. */
  lastTests?: { readonly fingerprint: string; readonly ok: boolean; readonly command: string };
  /** The staged state for which submit_change_set already asked for passing tests once. */
  submitGate?: string;
  /** find_relevant_code calls in this task, and the files they returned (best first). */
  searches?: { count: number; files: string[] };
  /** The staged state for which submit_change_set was already sent back for unstaged declared files. */
  coverageGate?: string;
}

/** A fingerprint of the staged edits, so a test result can be matched to exactly that state. */
export function stagedFingerprint(task: Task): string {
  const h = createHash('sha256');
  for (const p of task.changeSet.stagedPaths().sort()) {
    const v = task.changeSet.staged(p);
    h.update(`${p}\0${v?.deleted ? '<deleted>' : (v?.content ?? '')}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

export class TaskRegistry {
  private readonly tasks = new Map<string, Task>();
  private currentId: string | undefined;

  constructor(
    private readonly reader: FileReader,
    private readonly readsPerRunTokens: number,
  ) {}

  /** Starts a task and makes it current. Starting a task cancels the previous one. */
  start(id: string, turnId?: string): Task {
    if (this.currentId !== undefined && this.currentId !== id) this.cancel(this.currentId);
    let task = this.tasks.get(id);
    if (!task || task.cancelled) {
      task = {
        id,
        turnId,
        changeSet: new ChangeSet(id, this.reader),
        readBudget: new ReadBudget(this.readsPerRunTokens),
        controller: new AbortController(),
        cancelled: false,
      };
      this.tasks.set(id, task);
    } else if (turnId !== undefined) {
      task.turnId = turnId;
    }
    this.currentId = id;
    return task;
  }

  /** Records the TrueForge turn the task is now running (each continuation is a new turn). */
  setTurn(id: string, turnId: string): void {
    const task = this.tasks.get(id);
    if (task) task.turnId = turnId;
  }

  current(): Task | undefined {
    return this.currentId === undefined ? undefined : this.tasks.get(this.currentId);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Cancels a task: aborts running tool executions and discards its change set. */
  cancel(id: string = this.currentId ?? ''): void {
    const task = this.tasks.get(id);
    if (!task || task.cancelled) return;
    task.cancelled = true;
    task.controller.abort(new Error('Task cancelled'));
    task.changeSet.discard();
    if (this.currentId === id) this.currentId = undefined;
  }

  /** Ends a task normally (after apply or discard by the user). */
  finish(id: string): void {
    this.tasks.delete(id);
    if (this.currentId === id) this.currentId = undefined;
  }
}
