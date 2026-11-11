import { ChangeSet, type FileReader } from '../changeset/changeSet';
import { ReadBudget } from '../context/budget';

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
