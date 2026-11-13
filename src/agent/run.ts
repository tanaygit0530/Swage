import { randomUUID } from 'node:crypto';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeError, type ApprovalDecision, type SwageClient } from '../client/client';
import { agentNameFor } from '../client/manifest';
import { CONTINUE_MESSAGE, carryOverMessage } from '../resilience/carryOver';
import { classifyMessage, type Failure } from '../resilience/classify';
import {
  WORKSPACE_UNCHANGED,
  type Decision,
  type FallbackPlan,
  type ModelRouter,
} from '../resilience/fallback';
import type { ResolvedProfile } from '../resilience/profiles';
import { AGENT_TOOL_NAMES, textToolCalls } from '../resilience/textToolCall';
import { Watchdog, type Clock } from '../resilience/watchdog';
import type { PendingToolCall, SwageEvent } from '../client/events';
import { DEFAULT_BUDGETS, type Budgets } from '../context/budget';
import type { ChangeSet } from '../changeset/changeSet';
import type { ApprovalList, ToolContext } from '../mcp/context';
import { stagedFingerprint } from '../mcp/tasks';
import type { Logger } from '../supervisor/supervisor';
import { parseToolArgs, summarizeArgs, type HostToWebview, type RunState } from '../ui/protocol';
import { argsPreview, effectiveToolName, resultPreview, toolOutcome } from '../ui/toolDetail';
import { changeRows } from '../ui/changes';
import { fileStats } from '../review/model';
import type { EditableRange } from '../inline/context';
import { buildFirstMessage, type ContextPart, type FirstMessage } from './context';
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
  /**
   * Opens the Review view for a submitted change set and resolves when the user applies or
   * discards it (blueprint section 6, approval flow). Without it, the panel card decides.
   */
  readonly review?: (
    taskId: string,
    changeSet: ChangeSet,
  ) => Promise<{ applied: boolean; message: string }>;
  /**
   * Builds the first message instead of the agent-mode context (the inline edit passes the
   * selection, enclosing symbol, imports and nearby lines).
   */
  readonly firstMessage?: () => Promise<FirstMessage> | FirstMessage;
  /** Inline edits: the only lines the agent may change; recorded on the task for the range lock. */
  readonly editableRange?: EditableRange;
  /** Upper bound for draining a cancelled stream before giving up on `turn.done`. */
  readonly drainTimeoutMs?: number;
  /**
   * Resilience (blueprint section 8): with a router, the run starts on the active profile's agent
   * (`<agentBase>-<profile>`), arms that profile's timers, retries transient failures and
   * switches profiles on hard ones, carrying the task over. Without one, `agentName` is used and
   * any failure ends the run.
   */
  readonly router?: ModelRouter;
  /** Agent base name, for example `swage-main` or `swage-inline`. */
  readonly agentBase?: string;
  /** Makes sure the profile's agent exists in TrueForge before a session is created on it. */
  readonly prepareAgent?: (profile: ResolvedProfile, agentName: string) => Promise<void>;
  /** A fallback switch happened (for a toast and the status bar). */
  readonly onSwitch?: (decision: Extract<Decision, { action: 'switch' }>) => void;
  /** Timer source for the watchdog and backoff sleeps (tests). */
  readonly clock?: Clock;
  /** Every event of the current turn, as received (logs, evidence, the session export). */
  readonly onEvent?: (event: SwageEvent) => void;
  /** stage_edit changed a file (the review follows the staging change set for live diffs). */
  readonly onStaged?: (taskId: string, changeSet: ChangeSet, path: string) => void;
  /** The run ended without a review: the staging change set is gone. */
  readonly onDropped?: (taskId: string) => void;
}

export type RunOutcome = 'done' | 'paused' | 'cancelled' | 'error';

export const CANCELLED_MESSAGE = 'Cancelled. Workspace unchanged.';

interface PendingApproval extends PendingToolCall {
  decision?: ApprovalDecision;
}

/** The Plan card for a declare_context call waiting for approval, from its arguments. */
function planCard(call: PendingToolCall): HostToWebview {
  const args = parseToolArgs(call.arguments) ?? {};
  const steps = Array.isArray(args['plan'])
    ? args['plan'].filter((s): s is string => typeof s === 'string')
    : [];
  const files = Array.isArray(args['files'])
    ? args['files'].flatMap((f: unknown) => {
        const o = f as { path?: unknown; reason?: unknown } | null;
        return o && typeof o.path === 'string'
          ? [{ path: o.path, reason: typeof o.reason === 'string' ? o.reason : '' }]
          : [];
      })
    : [];
  return {
    type: 'plan',
    steps: steps.slice(0, 30).map((s) => s.slice(0, 2_000)),
    files: files
      .slice(0, 50)
      .map((f) => ({ path: f.path.slice(0, 2_000), reason: f.reason.slice(0, 2_000) })),
    toolCallId: call.toolCallId,
    awaiting: true,
  };
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
  private plan: FallbackPlan | undefined;
  private firstText = '';
  /** True once the current attempt produced any model or tool event. */
  private attemptActivity = false;
  private readonly sleeps = new Set<() => void>();
  /** The summary the agent gave with submit_change_set, for the walkthrough. */
  private submitSummary: string | undefined;
  /** Planning mode: the user approved a plan, so later declare_context calls pass on their own. */
  private planApproved = false;
  /** The files of the approved declare_context: its card already shows that plan. */
  private approvedPlanKey: string | undefined;

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
    const task = this.opts.ctx.tasks.start(this.taskId);
    if (this.opts.editableRange) task.editableRange = this.opts.editableRange;
    this.relaySubscription = this.opts.relay.attach({
      onDeclare: (taskId, plan, files) => {
        if (taskId !== this.taskId || this.cancelRequested) return;
        const key = JSON.stringify(files.map((f) => f.path));
        if (this.approvedPlanKey === key) {
          this.approvedPlanKey = undefined;
          return;
        }
        this.post({ type: 'plan', steps: [...plan], files: [...files] });
      },
      onStage: (taskId, path) => {
        if (taskId === this.taskId && !this.cancelRequested) this.staged(path);
      },
      onSubmit: (taskId, summary) => {
        if (taskId === this.taskId) this.submitSummary = summary;
      },
    });
    try {
      const first = this.opts.firstMessage
        ? await this.opts.firstMessage()
        : await buildFirstMessage(prompt, this.opts.ctx, this.budgets);
      this.parts = [...first.parts];
      this.total = first.total;
      this.postBudget();
      this.logger.info(
        `context assembled in ${Math.round(performance.now() - t0)} ms (${first.used} tokens)`,
      );
      if (this.cancelRequested) return await this.finished;
      this.firstText = first.text;

      if (this.opts.router) {
        this.plan = this.opts.router.begin();
        if (!(await this.openSession())) return await this.finished;
      } else {
        this.sessionId = await this.opts.client.createSession(this.opts.agentName);
      }
      if (this.cancelRequested) {
        if (this.sessionId !== undefined)
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

  /** The agent's declared reason per file. */
  private reasons(): Map<string, string> {
    const declared = this.opts.ctx.tasks.get(this.taskId)?.changeSet.declaredContext;
    return new Map((declared?.files ?? []).map((f) => [f.path, f.reason]));
  }

  /** A stage_edit landed: the file's card in the thread and the live files-changed bar. */
  private staged(path: string): void {
    const changeSet = this.opts.ctx.tasks.get(this.taskId)?.changeSet;
    if (!changeSet) return;
    const files = changeSet.review();
    const file = files.find((f) => f.path === path);
    const reasons = this.reasons();
    if (file) {
      const stats = fileStats(file);
      const reason = reasons.get(path);
      this.post({
        type: 'edit',
        taskId: this.taskId,
        path,
        kind: file.kind,
        added: stats.added,
        removed: stats.removed,
        ...(reason ? { reason } : {}),
      });
    }
    this.post({
      type: 'changes',
      phase: 'staging',
      files: changeRows(files, (p) => changeSet.base(p) ?? '', reasons),
    });
    this.opts.onStaged?.(this.taskId, changeSet, path);
  }

  /** The end of the task: the walkthrough card, just before the review opens. */
  private walkthrough(changeSet: ChangeSet, fallback: string): void {
    const reasons = this.reasons();
    this.post({
      type: 'walkthrough',
      summary: this.submitSummary?.trim() || fallback,
      files: changeRows(changeSet.review(), (p) => changeSet.base(p) ?? '', reasons).map((f) => ({
        path: f.path,
        kind: f.kind,
        added: f.added,
        removed: f.removed,
        ...(f.reason ? { reason: f.reason } : {}),
      })),
    });
  }

  /** Nothing staged survives (cancel or failure): the bar empties. */
  private dropChanges(): void {
    this.post({ type: 'changes', phase: 'none', files: [] });
    this.opts.onDropped?.(this.taskId);
  }

  /** The profile the run is on (with a router). */
  get profile(): ResolvedProfile | undefined {
    return this.plan?.current;
  }

  private agentFor(profile: ResolvedProfile): string {
    return agentNameFor(this.opts.agentBase ?? 'swage-main', profile);
  }

  /**
   * Creates a session on the current profile's agent. Failures go through the classifier: retry,
   * switch to the next profile, or fail. Returns false when the run ended.
   */
  private async openSession(): Promise<boolean> {
    const plan = this.plan;
    if (!plan) return false;
    for (;;) {
      if (this.cancelRequested) return false;
      const profile = plan.current;
      const name = this.agentFor(profile);
      try {
        await this.opts.prepareAgent?.(profile, name);
        this.sessionId = await this.opts.client.createSession(name);
        this.logger.info(`session on ${profile.name} (${profile.trueforgeModel})`);
        return true;
      } catch (err) {
        const f = classifyMessage(describeError(err));
        if (!(await this.apply(plan.decide(f), f))) return false;
      }
    }
  }

  /**
   * Carries out a fallback decision. Returns true when the caller should go on (after a retry
   * wait or a switch), false when the run ended.
   */
  private async apply(decision: Decision, f: Failure): Promise<boolean> {
    const profile = this.plan?.current;
    this.logger.warn(`model failure (${f.kind}): ${f.detail} -> ${decision.action}`);
    if (decision.action === 'fail') {
      // Giving up with edits already staged: keep them reviewable instead of throwing them away
      // (blueprint F15). Nothing is written unless the user applies it.
      const task = this.opts.ctx.tasks.get(this.taskId);
      const staged = task?.changeSet.stagedPaths() ?? [];
      if (staged.length > 0 && task?.changeSet.status === 'staging' && this.opts.review) {
        this.relaySubscription?.dispose();
        this.setState(
          'error',
          `${decision.message.replace(WORKSPACE_UNCHANGED, '').trim()} The ${staged.length} staged file(s) are open for review; nothing is applied unless you apply it.`,
        );
        this.walkthrough(
          task.changeSet,
          'The model stopped before submitting. These are the edits it staged.',
        );
        void this.opts.review(this.taskId, task.changeSet);
        return false;
      }
      this.fail(decision.message);
      return false;
    }
    if (decision.action === 'retry') {
      const s = Math.max(1, Math.round(decision.delayMs / 1000));
      this.setState(
        'running',
        `${profile?.label ?? 'The model'} ${f.reason}; retrying in ${s} s (retry ${decision.retry} of ${decision.of})…`,
      );
      await this.sleep(decision.delayMs);
      return !this.cancelRequested;
    }
    this.post({
      type: 'notice',
      tone: 'warning',
      message: decision.message,
      switchedFrom: decision.from.name,
    });
    this.post({ type: 'model', model: `${decision.to.label} (${decision.to.trueforgeModel})` });
    this.setState('running', decision.message);
    this.opts.onSwitch?.(decision);
    // Every model is waiting out a rate limit: wait for the first one, then go on with the task.
    if (decision.delayMs !== undefined && decision.delayMs > 0) await this.sleep(decision.delayMs);
    return !this.cancelRequested;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.sleeps.delete(done);
        resolve();
      };
      this.sleeps.add(done);
      const clock = this.opts.clock;
      if (clock) clock.setTimeout(done, ms);
      else setTimeout(done, ms).unref();
    });
  }

  /**
   * After a failed attempt: retry on the same profile, or move the task to the next profile with
   * a carry-over message, or end the run with one clear line.
   */
  private async recover(f: Failure, lastInput: TrueForgeApi.TurnInputItem[]): Promise<void> {
    const plan = this.plan;
    if (!plan || this.cancelRequested) return;
    const decision = plan.decide(f);
    const hadActivity = this.attemptActivity;
    if (!(await this.apply(decision, f)) || decision.action === 'fail') return;
    if (decision.action === 'retry') {
      const replay =
        !hadActivity && lastInput.length === 1 && lastInput[0]?.type === 'user.message';
      await this.runTurn(
        replay ? lastInput : [{ type: 'user.message', content: CONTINUE_MESSAGE }],
      );
      return;
    }
    // Switch: the old session is abandoned; the task (and its staged edits) carries over.
    const old = this.sessionId;
    if (old !== undefined) void this.opts.client.cancel(old).catch(() => undefined);
    this.sessionId = undefined;
    if (!(await this.openSession())) return;
    const task = this.opts.ctx.tasks.get(this.taskId);
    const declared = task?.changeSet.declaredContext;
    const text = carryOverMessage({
      original: this.firstText,
      why: `${decision.from.label} ${f.reason}`,
      plan: declared?.plan ?? [],
      files: declared?.files ?? [],
      staged: task?.changeSet.review() ?? [],
    });
    await this.runTurn([{ type: 'user.message', content: text }]);
  }

  private fail(message: string): void {
    if (this.cancelRequested) return;
    if (this.stateValue === 'error') return;
    this.opts.ctx.tasks.cancel(this.taskId);
    this.dropChanges();
    this.relaySubscription?.dispose();
    this.setState('error', message.split('\n')[0] ?? message);
  }

  /** Streams one TrueForge turn. Never breaks out early: it drains until the stream ends. */
  private async runTurn(input: TrueForgeApi.TurnInputItem[]): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === undefined) return;
    const seq = ++this.turnSeq;
    let myTurnId: string | undefined;
    let failure: Failure | undefined;
    let toolsThisAttempt = 0;
    let textThisAttempt = '';
    const drain = new AbortController();
    this.drains.add(drain);
    this.attemptActivity = false;
    const profile = this.plan?.current;
    const watchdog = profile
      ? new Watchdog({
          timeouts: profile.timeouts,
          ...(this.opts.clock ? { clock: this.opts.clock } : {}),
          onWaiting: (sec) => {
            if (seq === this.turnSeq && !this.cancelRequested)
              this.setState('running', `Waiting for ${profile.label} (${sec} s)…`);
          },
          onTimeout: (f) => {
            if (seq !== this.turnSeq || this.cancelRequested) return;
            // Abandon this attempt: its late events are dropped, TrueForge stops the turn.
            this.turnSeq++;
            this.activeTurnId = undefined;
            drain.abort();
            void this.opts.client.cancel(sessionId).catch(() => undefined);
            void this.recover(f, input);
          },
        })
      : undefined;
    watchdog?.start();
    try {
      for await (const event of this.opts.client.streamTurn(sessionId, input, {
        signal: drain.signal,
      })) {
        if (event.type === 'turn_started') {
          myTurnId = event.turnId;
          if (seq === this.turnSeq && !this.cancelRequested) {
            this.activeTurnId = event.turnId;
            this.opts.ctx.tasks.setTurn(this.taskId, event.turnId);
            watchdog?.connected();
          }
          continue;
        }
        if (
          watchdog &&
          event.type === 'error' &&
          myTurnId === undefined &&
          seq === this.turnSeq &&
          !this.cancelRequested
        ) {
          // The turn never started (TrueForge refused the request): classify it all the same.
          failure = classifyMessage(event.message);
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
        this.opts.onEvent?.(event);
        if (watchdog) {
          if (event.type === 'text') watchdog.activity();
          else if (event.type === 'tool_start') watchdog.toolStarted(event.toolCallId);
          else if (event.type === 'tool_result') watchdog.toolEnded(event.toolCallId);
          else watchdog.stop();
          if (event.type === 'text' || event.type === 'tool_start') this.attemptActivity = true;
          if (event.type === 'tool_start') toolsThisAttempt++;
          if (event.type === 'text') textThisAttempt += event.delta;
          if (event.type === 'done' && !event.paused && toolsThisAttempt === 0) {
            // A tool call written out as text: this model cannot call tools here (see textToolCall.ts).
            const written = textToolCalls(event.output || textThisAttempt, AGENT_TOOL_NAMES);
            if (written.length > 0) {
              failure = {
                kind: 'hard',
                reason: 'wrote its tool call as text instead of calling the tool',
                detail: `${profile?.trueforgeModel ?? 'the model'} replied with ${written[0] ?? 'a tool'} as text`,
              };
              continue;
            }
          }
          if (event.type === 'error') {
            // Decided after the stream ends: retry, switch or fail.
            failure = classifyMessage(event.message);
            continue;
          }
          if (event.type === 'done') this.plan?.succeeded();
        }
        this.handle(event);
      }
    } finally {
      watchdog?.stop();
      this.drains.delete(drain);
      this.postDrained();
    }
    if (failure && seq === this.turnSeq && !this.cancelRequested)
      await this.recover(failure, input);
    else if (watchdog && seq === this.turnSeq && !this.cancelRequested && myTurnId === undefined)
      // The stream ended without a turn: the connection to TrueForge failed.
      await this.recover(classifyMessage('terminated'), input);
  }

  private handle(event: SwageEvent): void {
    switch (event.type) {
      case 'text':
        this.post({ type: 'text', messageId: event.messageId, delta: event.delta });
        break;
      case 'tool_start': {
        const name = effectiveToolName(event.name, event.arguments);
        this.toolStarts.set(event.toolCallId, { name, at: Date.now() });
        this.post({
          type: 'tool_start',
          toolCallId: event.toolCallId,
          name,
          summary: summarizeArgs(name, event.arguments),
          args: argsPreview(event.arguments),
        });
        break;
      }
      case 'tool_result': {
        const started = this.toolStarts.get(event.toolCallId);
        const isError = /^\s*\{\s*"error"/.test(event.content);
        const outcome = toolOutcome(started?.name ?? '', event.content, isError);
        this.post({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          durationMs: started ? Date.now() - started.at : 0,
          resultChars: event.content.length,
          error: isError,
          ...(outcome === undefined ? {} : { outcome }),
          result: resultPreview(event.content),
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
        this.dropChanges();
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
      // Test gate (blueprint F13): edits are not put in front of the user before they passed
      // run_tests once. The first submit of an untested or failing state is declined with the
      // reason; submitting the same edits again opens the review (for changes no test covers).
      const submit = this.pending.find((p) => p.name === 'submit_change_set');
      if (submit && task && this.pending.length === 1) {
        const fingerprint = stagedFingerprint(task);
        const tested = task.lastTests;
        if (
          !(tested?.fingerprint === fingerprint && tested.ok) &&
          task.submitGate !== fingerprint
        ) {
          task.submitGate = fingerprint;
          this.post({
            type: 'notice',
            tone: 'info',
            message: 'Swage asked the agent to pass run_tests before showing the change set.',
          });
          this.declineInternally(
            submit,
            tested?.fingerprint === fingerprint
              ? `Not submitted: run_tests failed on these exact staged edits (${tested.command}). Fix the failure, run the tests again, then call submit_change_set. If the failure is unrelated to this change, call submit_change_set again and say why in the summary.`
              : 'Not submitted: no passing run_tests on the current staged edits. Run the relevant tests with run_tests (for example the test file you changed), fix any failure, then call submit_change_set. If no test applies, call submit_change_set again and say why in the summary.',
          );
          return;
        }
      }
      // Planning mode (redesign step 6): a paused declare_context is the plan, shown as the Plan
      // card with Approve and Edit. Once a plan is approved, later declarations pass on their own.
      const declares = this.pending.filter((p) => p.name === 'declare_context');
      if (declares.length > 0 && this.planApproved && declares.length === this.pending.length) {
        this.resumeInternally(
          declares.map((d) => ({ threadId: d.threadId, toolCallId: d.toolCallId, allow: true })),
          'Running…',
        );
        return;
      }
      for (const d of declares) this.post(planCard(d));
      const others = this.pending.filter((p) => p.name !== 'declare_context');
      if (others.length > 0)
        this.post({
          type: 'approval',
          calls: others.map((p) => ({
            toolCallId: p.toolCallId,
            threadId: p.threadId,
            name: p.name,
            summary: this.approvalSummary(p, task?.changeSet.review() ?? []),
          })),
        });
      if (declares.length > 0) {
        this.setState('paused', 'Review the plan: Approve it, or Edit it to send it back');
        return;
      }
      if (submit && this.opts.review && task) {
        this.walkthrough(task.changeSet, summarizeArgs(submit.name, submit.arguments));
        this.setState(
          'paused',
          'Review the change set: accept or reject blocks, then Apply or Discard',
        );
        void this.opts
          .review(this.taskId, task.changeSet)
          .then((outcome) =>
            this.decide(
              submit.toolCallId,
              outcome.applied,
              outcome.applied ? undefined : outcome.message,
            ),
          );
        return;
      }
      this.setState('paused', 'Waiting for your approval');
      return;
    }
    this.pending = [];
    this.relaySubscription?.dispose();
    const task = this.opts.ctx.tasks.get(this.taskId);
    const staged = task?.changeSet.stagedPaths() ?? [];
    const submitted = task?.changeSet.status === 'submitted';
    // Only edits still in staging: after Apply or Discard the change set has moved on.
    if (staged.length > 0 && task?.changeSet.status === 'staging' && this.opts.review) {
      // The agent stopped (step limit, or it gave up) without submitting: its staged edits are
      // still reviewable, never lost and never written without the user (blueprint F15).
      this.setState(
        'done',
        `The agent stopped without submitting. Review the ${staged.length} staged file(s): apply what you want, or discard.`,
      );
      this.walkthrough(
        task.changeSet,
        'The agent stopped without submitting. These are the edits it staged.',
      );
      void this.opts.review(this.taskId, task.changeSet);
      return;
    }
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

  /**
   * Declines one pending call without asking the user and resumes the turn (the test gate). The
   * run stays running: no approval card is shown and start()'s outcome is not resolved early.
   */
  private declineInternally(call: PendingApproval, reason: string): void {
    this.resumeInternally(
      [{ threadId: call.threadId, toolCallId: call.toolCallId, allow: false, reason }],
      'Asking the agent to pass run_tests before review…',
    );
  }

  /** Answers pending calls without a card and resumes the turn. */
  private resumeInternally(decisions: ApprovalDecision[], message: string): void {
    this.pending = [];
    this.setState('running', message);
    void this.runTurnWithApprovals(decisions);
  }

  /**
   * The Plan card (Planning mode): Approve lets declare_context run, so edits can follow; Edit
   * sends the plan back with the user's feedback, and the agent declares a revised plan.
   */
  decidePlan(
    toolCallId: string,
    approve: boolean,
    feedback?: string,
  ): Promise<RunOutcome | undefined> {
    const call = this.pending.find((p) => p.toolCallId === toolCallId);
    if (call?.name !== 'declare_context') return Promise.resolve(undefined);
    if (approve) {
      this.planApproved = true;
      const files = (parseToolArgs(call.arguments)?.['files'] ?? []) as { path?: unknown }[];
      this.approvedPlanKey = JSON.stringify(
        Array.isArray(files) ? files.map((f) => (f as { path?: unknown } | null)?.path) : [],
      );
      return this.decide(toolCallId, true);
    }
    const note = feedback?.trim();
    return this.decide(
      toolCallId,
      false,
      `The user asked to revise the plan${note ? `: ${note}` : '.'} Call declare_context again with the revised plan before staging any edit.`,
    );
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
    for (const wake of [...this.sleeps]) wake();
    this.setState('cancelled', CANCELLED_MESSAGE);
    this.relaySubscription?.dispose();
    this.opts.ctx.tasks.cancel(this.taskId);
    this.dropChanges();
    // Safety net: if TrueForge never ends the stream with turn.done, stop draining eventually.
    const open = [...this.drains];
    setTimeout(() => open.forEach((d) => d.abort()), this.opts.drainTimeoutMs ?? 15_000).unref();
    this.postDrained();
    if (this.sessionId !== undefined) {
      await this.opts.client.cancel(this.sessionId).catch((err: unknown) => {
        this.logger.warn(`TrueForge cancel failed: ${describeError(err)}`);
      });
    }
  }

  private drainedPosted = false;

  /** After Stop: tell the panel once no cancelled stream is left, so Stop turns back into Send. */
  private postDrained(): void {
    if (!this.cancelRequested || this.drainedPosted || this.drains.size > 0) return;
    this.drainedPosted = true;
    this.post({ type: 'drained' });
  }

  /** True while a stream is still being drained (for tests and the controller). */
  get draining(): boolean {
    return this.drains.size > 0;
  }

  /** True if this pending call is the change-set submission handled by the Review view. */
  isReviewCall(toolCallId: string): boolean {
    return (
      this.opts.review !== undefined &&
      this.pending.some((p) => p.toolCallId === toolCallId && p.name === 'submit_change_set')
    );
  }

  /** Calls waiting for the user's approval (the panel shows them as cards). */
  get pendingCalls(): readonly { toolCallId: string; name: string }[] {
    return this.pending.map((p) => ({ toolCallId: p.toolCallId, name: p.name }));
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
