import { randomUUID } from 'node:crypto';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeError, type ApprovalDecision, type SwageClient } from '../client/client';
import type { PendingToolCall, SwageEvent } from '../client/events';
import { DEFAULT_BUDGETS, type Budgets } from '../context/budget';
import type { ApprovalList, ToolContext } from '../mcp/context';
import type { Logger } from '../supervisor/supervisor';
import { parseToolArgs, summarizeArgs, type HostToWebview, type RunState } from '../ui/protocol';
import { buildFirstMessage, type ContextPart } from './context';
import type { EventRelay } from './relay';

/**
 * One agent run end to end (blueprint sections 4 and 8): assemble context, open a TrueForge
 * session on the agent, stream the turn into the panel, pause on approval cards and resume.
 * Cancellation follows section 8 exactly: the UI flips at once, TrueForge cancel and our own
 * tool abort run in parallel, the stream is drained until `turn.done`, late events are dropped
 * by turn id, and the overlay is discarded, so the workspace is never touched.
 */

export interface AgentView {
  post(msg: HostToWebview): void;
}

export interface AgentRunOptions {
  readonly client: SwageClient;
  readonly ctx: ToolContext;
  readonly relay: EventRelay;
  readonly approvals: ApprovalList;
  readonly agentName: string;
  readonly view: AgentView;
  readonly budgets?: Budgets;
  readonly logger?: Logger;
  /** Upper bound for draining a cancelled stream before giving up on `turn.done`. */
  readonly drainTimeoutMs?: number;
}

export type RunOutcome = 'done' | 'paused' | 'cancelled' | 'error';

export const CANCELLED_MESSAGE = 'Cancelled. Workspace unchanged.';

interface PendingApproval extends PendingToolCall {
  decision?: ApprovalDecision;
}

/** A string argument from a tool call's raw JSON arguments, or '' if absent or unparseable. */
function argString(rawArgs: string, key: string): string {
  const value = parseToolArgs(rawArgs)?.[key];
  return typeof value === 'string' ? value : '';
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class AgentRun {
  readonly taskId = `task-${randomUUID()}`;
  private stateValue: RunState = 'idle';
  private sessionId: string | undefined;
  /** The TrueForge turn whose events the panel shows. */
  private activeTurnId: string | undefined;
  private turnSeq = 0;
  private cancelRequested = false;
  private readonly toolStarts = new Map<string, { name: string; at: number }>();
  private pending: PendingApproval[] = [];
  private parts: ContextPart[] = [];
  private total = 1;
  private prompt = '';
  private droppedEvents = 0;
  private readonly logger: Logger;
  private readonly budgets: Budgets;
  private readonly finished: Promise<RunOutcome>;
  private resolveFinished: (o: RunOutcome) => void = () => undefined;
  private relaySubscription: { dispose(): void } | undefined;
  private readonly drains = new Set<AbortController>();
  private cancelledAt: number | undefined;

  constructor(private readonly opts: AgentRunOptions) {
    this.logger = opts.logger ?? silent;
    this.budgets = opts.budgets ?? DEFAULT_BUDGETS;
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
  }

  get state(): RunState {
    return this.stateValue;
  }

  /** Events ignored because they arrived for a cancelled or superseded turn. */
  get dropped(): number {
    return this.droppedEvents;
  }

  /** Resolves when the run ends, pauses for approval, is cancelled or fails. */
  outcome(): Promise<RunOutcome> {
    return this.finished;
  }

  private post(msg: HostToWebview): void {
    this.opts.view.post(msg);
  }

  private setState(state: RunState, message?: string): void {
    this.stateValue = state;
    this.post({ type: 'status', state, ...(message === undefined ? {} : { message }) });
    if (state === 'done' || state === 'paused' || state === 'cancelled' || state === 'error') {
      this.resolveFinished(state);
    }
  }

  private postBudget(): void {
    const reads = this.opts.ctx.tasks.get(this.taskId)?.readBudget.used ?? 0;
    const parts = [...this.parts, { label: 'file reads', tokens: reads }];
    const used = parts.reduce((n, p) => n + p.tokens, 0);
    this.post({ type: 'budget', used, total: Math.max(this.total, used), parts });
  }

  /** Starts the run. Resolves with the first outcome (done, paused, cancelled or error). */
  async start(prompt: string): Promise<RunOutcome> {
    this.prompt = prompt;
    this.setState('starting', 'Assembling context…');
    this.post({ type: 'user', text: prompt });
    const t0 = performance.now();
    this.opts.ctx.tasks.start(this.taskId);
    this.relaySubscription = this.opts.relay.attach({
      onDeclare: (taskId, plan, files) => {
        if (taskId === this.taskId && !this.cancelRequested)
          this.post({ type: 'plan', steps: [...plan], files: [...files] });
      },
    });
    try {
      const first = await buildFirstMessage(prompt, this.opts.ctx, this.budgets);
      this.parts = [...first.parts];
      this.total = first.total;
      this.postBudget();
      this.logger.info(
        `context assembled in ${Math.round(performance.now() - t0)} ms (${first.used} tokens)`,
      );
      if (this.cancelRequested) return await this.finished;

      this.sessionId = await this.opts.client.createSession(this.opts.agentName);
      if (this.cancelRequested) {
        await this.opts.client.cancel(this.sessionId).catch(() => undefined);
        return await this.finished;
      }
      this.setState('running', 'Running…');
      void this.runTurn([{ type: 'user.message', content: first.text }]);
    } catch (err) {
      this.fail(describeError(err));
    }
    return this.finished;
  }

  private fail(message: string): void {
    if (this.cancelRequested) return;
    this.opts.ctx.tasks.cancel(this.taskId);
    this.relaySubscription?.dispose();
    this.setState('error', message.split('\n')[0] ?? message);
  }

  /** Streams one TrueForge turn. Never breaks out early: it drains until the stream ends. */
  private async runTurn(input: TrueForgeApi.TurnInputItem[]): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) return;
    const seq = ++this.turnSeq;
    let myTurnId: string | undefined;
    const drain = new AbortController();
    this.drains.add(drain);
    try {
      for await (const event of this.opts.client.streamTurn(sessionId, input, {
        signal: drain.signal,
      })) {
        if (event.type === 'turn_started') {
          myTurnId = event.turnId;
          if (seq === this.turnSeq && !this.cancelRequested) {
            this.activeTurnId = event.turnId;
            this.opts.ctx.tasks.setTurn(this.taskId, event.turnId);
          }
          continue;
        }
        const current =
          seq === this.turnSeq && myTurnId === this.activeTurnId && !this.cancelRequested;
        if (!current) {
          // Late or stale: from a cancelled turn, or from a turn superseded by a newer one.
          if (event.type !== 'done' && event.type !== 'cancelled' && event.type !== 'error')
            this.droppedEvents++;
          if (
            this.cancelRequested &&
            (event.type === 'done' || event.type === 'cancelled' || event.type === 'error')
          ) {
            this.logger.info(
              `turn ended after cancel (${event.type}) in ${Date.now() - (this.cancelledAt ?? Date.now())} ms`,
            );
          }
          continue;
        }
        this.handle(event);
      }
    } finally {
      this.drains.delete(drain);
    }
  }

  private handle(event: SwageEvent): void {
    switch (event.type) {
      case 'text':
        this.post({ type: 'text', messageId: event.messageId, delta: event.delta });
        break;
      case 'tool_start':
        this.toolStarts.set(event.toolCallId, { name: event.name, at: Date.now() });
        this.post({
          type: 'tool_start',
          toolCallId: event.toolCallId,
          name: event.name,
          summary: summarizeArgs(event.name, event.arguments),
        });
        break;
      case 'tool_result': {
        const started = this.toolStarts.get(event.toolCallId);
        const isError = /^\s*\{\s*"error"/.test(event.content);
        this.post({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          durationMs: started ? Date.now() - started.at : 0,
          resultChars: event.content.length,
          error: isError,
        });
        if (started?.name === 'read_files' || started?.name === 'get_symbol') this.postBudget();
        break;
      }
      case 'approval_required':
        this.pending.push(...event.calls);
        break;
      case 'done':
        this.onDone(event);
        break;
      case 'cancelled':
        this.relaySubscription?.dispose();
        this.setState(
          'cancelled',
          event.reason === 'cancelled-for-next-turn'
            ? 'This turn was replaced by a newer one.'
            : `Stopped by TrueForge (${event.reason}). Nothing was applied.`,
        );
        this.opts.ctx.tasks.cancel(this.taskId);
        break;
      case 'error':
        this.fail(event.message);
        break;
      default:
        break;
    }
  }

  private onDone(event: Extract<SwageEvent, { type: 'done' }>): void {
    const pending = event.pending.length > 0 ? event.pending : this.pending;
    if (event.paused && pending.length > 0) {
      this.pending = pending.map((p) => ({ ...p }));
      const task = this.opts.ctx.tasks.get(this.taskId);
      this.post({
        type: 'approval',
        calls: this.pending.map((p) => ({
          toolCallId: p.toolCallId,
          threadId: p.threadId,
          name: p.name,
          summary: this.approvalSummary(p, task?.changeSet.review() ?? []),
        })),
      });
      this.setState('paused', 'Waiting for your approval');
      return;
    }
    this.pending = [];
    this.relaySubscription?.dispose();
    const task = this.opts.ctx.tasks.get(this.taskId);
    const staged = task?.changeSet.stagedPaths() ?? [];
    const submitted = task?.changeSet.status === 'submitted';
    this.setState(
      'done',
      staged.length > 0 && !submitted
        ? `The agent finished without submitting; ${staged.length} file(s) are staged.`
        : 'Finished.',
    );
  }

  private approvalSummary(
    p: PendingToolCall,
    review: readonly { path: string; kind: string; blocks: readonly unknown[] }[],
  ): string {
    if (p.name === 'submit_change_set') {
      const lines = review.map((f) => `${f.kind} ${f.path} (${f.blocks.length} block(s))`);
      return [summarizeArgs(p.name, p.arguments), ...lines].join('\n');
    }
    if (p.name === 'run_command') {
      const reason = argString(p.arguments, 'reason');
      return `${summarizeArgs(p.name, p.arguments)}${reason ? `\nReason: ${reason}` : ''}`;
    }
    return summarizeArgs(p.name, p.arguments);
  }

  /**
   * Records the user's decision for one pending call. When every pending call is decided,
   * resumes the paused turn with one `user.tool_approval` per call.
   */
  async decide(
    toolCallId: string,
    allow: boolean,
    reason?: string,
  ): Promise<RunOutcome | undefined> {
    const p = this.pending.find((x) => x.toolCallId === toolCallId);
    if (!p || this.stateValue !== 'paused' || this.sessionId === undefined) return undefined;
    p.decision = {
      threadId: p.threadId,
      toolCallId,
      allow,
      ...(reason === undefined ? {} : { reason }),
    };
    this.post({ type: 'approval_resolved', toolCallId, allowed: allow });
    if (allow && p.name === 'run_command') {
      // Unparseable arguments give an empty command, which the tool refuses without an approval.
      this.opts.approvals.approve(this.taskId, argString(p.arguments, 'command'));
    }
    if (this.pending.some((x) => x.decision === undefined)) return undefined;

    const decisions = this.pending.map((x) => x.decision as ApprovalDecision);
    this.pending = [];
    const resumed = new Promise<RunOutcome>((resolve) => {
      this.resolveFinished = resolve;
    });
    this.setState('running', 'Running…');
    void this.runTurnWithApprovals(decisions);
    return resumed;
  }

  private async runTurnWithApprovals(decisions: ApprovalDecision[]): Promise<void> {
    const input: TrueForgeApi.TurnInputItem[] = decisions.map((d) => ({
      type: 'user.tool_approval',
      threadId: d.threadId,
      toolCallId: d.toolCallId,
      approval: d.allow
        ? { status: 'allow' }
        : { status: 'deny', ...(d.reason === undefined ? {} : { reason: d.reason }) },
    }));
    await this.runTurn(input);
  }

  /**
   * Stop (blueprint section 8): flip the UI at once, then cancel the TrueForge turn and abort our
   * own tool executions in parallel. The stream keeps draining until `turn.done`; its events are
   * dropped. The overlay is discarded, so nothing staged survives.
   */
  async cancel(): Promise<void> {
    if (this.cancelRequested) return;
    if (
      this.stateValue === 'done' ||
      this.stateValue === 'cancelled' ||
      this.stateValue === 'error'
    )
      return;
    this.cancelRequested = true;
    this.cancelledAt = Date.now();
    this.setState('cancelled', CANCELLED_MESSAGE);
    this.relaySubscription?.dispose();
    this.opts.ctx.tasks.cancel(this.taskId);
    // Safety net: if TrueForge never ends the stream with turn.done, stop draining eventually.
    const open = [...this.drains];
    setTimeout(() => open.forEach((d) => d.abort()), this.opts.drainTimeoutMs ?? 15_000).unref();
    if (this.sessionId !== undefined) {
      await this.opts.client.cancel(this.sessionId).catch((err: unknown) => {
        this.logger.warn(`TrueForge cancel failed: ${describeError(err)}`);
      });
    }
  }

  /** True while a stream is still being drained (for tests and the controller). */
  get draining(): boolean {
    return this.drains.size > 0;
  }

  /** The TrueForge session id, once created. */
  get session(): string | undefined {
    return this.sessionId;
  }

  /** The original request, for Retry. */
  get request(): string {
    return this.prompt;
  }
}
