import type { ReviewSession } from './session';

/**
 * The session's reviews, one per agent turn (review upgrade, step 5). Starting a new review
 * parks the one in progress with its decisions intact, so each turn's change set can be
 * reviewed, accepted or rejected on its own later. A parked turn whose files changed on disk is
 * caught by the apply's hash check, which refuses with a conflict. No VS Code dependency.
 */

export interface QueuedReview<F, M> {
  readonly session: ReviewSession;
  /** Called once when the review ends (resumes the turn's agent run). */
  readonly onFinish: F | undefined;
  readonly mode: M;
}

export interface TurnSummary {
  readonly taskId: string;
  readonly files: number;
  /** Files still waiting for a decision. */
  readonly open: number;
  readonly current: boolean;
}

export class ReviewQueue<F, M> {
  private readonly parked = new Map<string, QueuedReview<F, M>>();
  private active: QueuedReview<F, M> | undefined;

  get current(): QueuedReview<F, M> | undefined {
    return this.active;
  }

  /** Makes a review current; the one in progress, if any, is parked. */
  start(review: QueuedReview<F, M>): void {
    if (this.active && this.active.session.taskId !== review.session.taskId)
      this.parked.set(this.active.session.taskId, this.active);
    this.parked.delete(review.session.taskId);
    this.active = review;
  }

  /** Brings a parked turn's review back; the current one is parked. False if it is unknown. */
  resume(taskId: string): boolean {
    const review = this.parked.get(taskId);
    if (!review) return this.active?.session.taskId === taskId;
    this.start(review);
    return true;
  }

  /** The current review ended; no review is current until one starts or resumes. */
  finishCurrent(): QueuedReview<F, M> | undefined {
    const done = this.active;
    this.active = undefined;
    return done;
  }

  /** Drops a parked turn (its run was cancelled, or the user discarded it). */
  drop(taskId: string): void {
    this.parked.delete(taskId);
  }

  /** Every turn with a review, the current one first, then parked turns newest first. */
  summaries(): TurnSummary[] {
    const all = [
      ...(this.active ? [{ r: this.active, current: true }] : []),
      ...[...this.parked.values()].reverse().map((r) => ({ r, current: false })),
    ];
    return all.map(({ r, current }) => ({
      taskId: r.session.taskId,
      files: r.session.files().length,
      open: r.session.openFiles().length,
      current,
    }));
  }

  /** The review of a turn, current or parked. */
  sessionOf(taskId: string): ReviewSession | undefined {
    if (this.active?.session.taskId === taskId) return this.active.session;
    return this.parked.get(taskId)?.session;
  }

  has(taskId: string): boolean {
    return this.active?.session.taskId === taskId || this.parked.has(taskId);
  }
}
