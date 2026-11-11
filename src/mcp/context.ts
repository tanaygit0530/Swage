import { promises as fsp } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_BUDGETS, type Budgets } from '../context/budget';
import type { Bm25Searcher } from '../context/bm25';
import type { WorkspaceIndex } from '../context/indexer';
import { PathGuard } from '../safety/pathGuard';
import { redactText } from '../safety/redact';
import type { Logger } from '../supervisor/supervisor';
import { TaskRegistry, type Task } from './tasks';

/**
 * Shared context for the editor tools (blueprint section 6) and the rules every tool follows:
 * results are redacted, errors are structured and actionable, each call is timed, and a result
 * from a cancelled or superseded turn is discarded.
 */

/** UI notifications. The extension shows the declaration, staged edits and submissions. */
export interface ToolEvents {
  onDeclare?(
    taskId: string,
    plan: readonly string[],
    files: readonly { path: string; reason: string }[],
  ): void;
  onStage?(taskId: string, path: string): void;
  onSubmit?(taskId: string, summary: string): void;
  onCommand?(taskId: string, command: string, outcome: string): void;
}

/** Commands the user approved (TrueForge pauses run_command for approval by name). */
export interface CommandApprovals {
  /** Returns true once for each approved command. */
  consume(taskId: string, command: string): boolean;
}

export class ApprovalList implements CommandApprovals {
  private readonly approved = new Map<string, string[]>();

  approve(taskId: string, command: string): void {
    this.approved.set(taskId, [...(this.approved.get(taskId) ?? []), command.trim()]);
  }

  consume(taskId: string, command: string): boolean {
    const list = this.approved.get(taskId) ?? [];
    const i = list.indexOf(command.trim());
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }
}

export interface ToolContext {
  readonly root: string;
  readonly guard: PathGuard;
  readonly index: WorkspaceIndex;
  readonly searcher: Bm25Searcher;
  readonly budgets: Budgets;
  readonly tasks: TaskRegistry;
  readonly approvals: CommandApprovals;
  readonly events: ToolEvents;
  readonly logger: Logger;
  /** Reads a workspace file (read-only); `undefined` if missing. */
  readText(relative: string): Promise<string | undefined>;
}

export interface ContextOptions {
  readonly root: string;
  readonly index: WorkspaceIndex;
  readonly searcher: Bm25Searcher;
  readonly budgets?: Budgets;
  readonly ignorePatterns?: readonly string[];
  readonly approvals?: CommandApprovals;
  readonly events?: ToolEvents;
  readonly logger?: Logger;
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function createToolContext(options: ContextOptions): ToolContext {
  const guard = new PathGuard({ root: options.root, ignorePatterns: options.ignorePatterns ?? [] });
  const readText = async (relative: string): Promise<string | undefined> => {
    const resolved = guard.resolve(relative);
    if (!resolved.ok) return undefined;
    return fsp.readFile(resolved.absolute, 'utf8').catch(() => undefined);
  };
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  return {
    root: options.root,
    guard,
    index: options.index,
    searcher: options.searcher,
    budgets,
    tasks: new TaskRegistry({ read: readText }, budgets.readsPerRunTokens),
    approvals: options.approvals ?? new ApprovalList(),
    events: options.events ?? {},
    logger: options.logger ?? silent,
    readText,
  };
}

/** A structured, agent-readable tool error. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: redactText(text) }] };
}

export function errorResult(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const body = JSON.stringify({ error: { code, message, ...(details ?? {}) } }, null, 2);
  return { content: [{ type: 'text', text: redactText(body) }], isError: true };
}

export interface ToolCall {
  readonly task: Task;
  /** Aborted when the task is cancelled or TrueForge cancels the MCP request. */
  readonly signal: AbortSignal;
}

/**
 * Wraps a tool handler with the shared rules: an active task is required, the call is
 * timed and logged, errors become structured results, every result is redacted, and a
 * result that arrives after the task was cancelled or moved to another turn is discarded.
 */
export function runTool<A>(
  ctx: ToolContext,
  name: string,
  handler: (args: A, call: ToolCall) => Promise<CallToolResult>,
): (args: A, extra: { signal: AbortSignal }) => Promise<CallToolResult> {
  return async (args, extra) => {
    const started = performance.now();
    const task = ctx.tasks.current();
    let outcome = 'ok';
    try {
      if (!task) {
        outcome = 'no_active_task';
        return errorResult(
          'no_active_task',
          'Swage has no running task. Start a request from the Swage panel or inline edit.',
        );
      }
      const turnAtStart = task.turnId;
      const signal = AbortSignal.any([task.controller.signal, extra.signal]);
      const result = await handler(args, { task, signal });
      if (task.cancelled || signal.aborted || task.turnId !== turnAtStart) {
        outcome = 'discarded';
        return errorResult(
          'cancelled',
          'The task was cancelled or moved to a new turn; this result was discarded.',
        );
      }
      if (result.isError === true) outcome = 'error';
      // Redact once more in case a handler built a raw result.
      return {
        ...result,
        content: result.content.map((c) =>
          c.type === 'text' ? { ...c, text: redactText(c.text) } : c,
        ),
      };
    } catch (err) {
      if (err instanceof ToolError) {
        outcome = err.code;
        return errorResult(err.code, err.message, err.details);
      }
      if (task?.cancelled === true) {
        outcome = 'discarded';
        return errorResult('cancelled', 'The task was cancelled; this result was discarded.');
      }
      outcome = 'internal_error';
      return errorResult(
        'internal_error',
        `Swage could not complete ${name}: ${(err as Error).message}`,
      );
    } finally {
      ctx.logger.info(`tool ${name} ${Math.round(performance.now() - started)} ms ${outcome}`);
    }
  };
}
