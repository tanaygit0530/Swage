import { AgentRun } from '../agent/run';
import type { EventRelay } from '../agent/relay';
import type { SwageClient } from '../client/client';
import type { ChangeSet } from '../changeset/changeSet';
import type { ApprovalList, ToolContext } from '../mcp/context';
import type { Logger } from '../supervisor/supervisor';
import type { HostToWebview } from '../ui/protocol';
import {
  buildInlineMessage,
  DEFAULT_INLINE_BUDGETS,
  type EditableRange,
  type InlineBudgets,
  type InlineRequest,
} from './context';
import { extractFencedCode, replaceRange } from './fenced';
import { blocksOutside } from './rangeLock';

/**
 * One inline edit (blueprint sections 3 and 8): the inline agent (declare_context and stage_edit
 * only, iteration limit 8) runs through the same AgentRun as agent mode, so streaming and
 * cancellation follow exactly the same path. The result is a change set for block review; when
 * the model answers with a code block instead of a tool call, that block replaces the selection.
 */

export interface InlineEditOptions {
  readonly client: SwageClient;
  readonly ctx: ToolContext;
  readonly relay: EventRelay;
  readonly approvals: ApprovalList;
  /** The inline agent for the active profile, for example `swage-inline-primary`. */
  readonly agentName: string;
  readonly request: InlineRequest;
  readonly budgets?: InlineBudgets;
  readonly logger?: Logger;
  /** Status line updates while the run streams (the status bar shows them). */
  readonly onStatus?: (text: string) => void;
  /** Every panel-style event of the run (tool rows, text), for logs and rehearsals. */
  readonly onEvent?: (event: HostToWebview) => void;
  readonly drainTimeoutMs?: number;
}

export type InlineOutcome =
  | {
      readonly kind: 'review';
      readonly taskId: string;
      readonly changeSet: ChangeSet;
      /** Block ids per file that change lines outside the editable range. */
      readonly outside: ReadonlyMap<string, readonly string[]>;
      /** True when the change came from a fenced code block, not from stage_edit. */
      readonly fallback: boolean;
      readonly message: string;
    }
  | { readonly kind: 'nothing'; readonly message: string }
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const STATUS_WIDTH = 48;

/** The last few words of the streamed reply, on one line, for the status bar. */
export function tail(text: string, width = STATUS_WIDTH): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `…${flat.slice(flat.length - width + 1)}`;
}

export class InlineEdit {
  readonly run: AgentRun;
  readonly range: EditableRange;
  private reply = '';
  private lastMessage = '';

  constructor(private readonly opts: InlineEditOptions) {
    const { request } = opts;
    this.range = { path: request.path, ...request.range };
    this.run = new AgentRun({
      client: opts.client,
      ctx: opts.ctx,
      relay: opts.relay,
      approvals: opts.approvals,
      agentName: opts.agentName,
      view: { post: (m) => this.onPost(m) },
      firstMessage: () => buildInlineMessage(request, opts.budgets ?? DEFAULT_INLINE_BUDGETS),
      editableRange: this.range,
      ...(opts.logger === undefined ? {} : { logger: opts.logger }),
      ...(opts.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: opts.drainTimeoutMs }),
    });
  }

  get taskId(): string {
    return this.run.taskId;
  }

  /** The model's streamed text so far. */
  get text(): string {
    return this.reply;
  }

  private status(text: string): void {
    this.opts.onStatus?.(text);
  }

  private onPost(m: HostToWebview): void {
    this.opts.onEvent?.(m);
    switch (m.type) {
      case 'status':
        if (m.message !== undefined) this.lastMessage = m.message;
        if (m.state === 'starting' || m.state === 'running') this.status(m.message ?? 'Running…');
        break;
      case 'text':
        this.reply += m.delta;
        this.status(tail(this.reply));
        break;
      case 'tool_start':
        this.status(m.name === 'stage_edit' ? 'Staging the edit…' : `${m.name}…`);
        break;
      case 'tool_end':
        if (m.error) this.status('The edit did not apply; the model is retrying…');
        break;
      default:
        break;
    }
  }

  /** Runs the inline agent; resolves when there is something to review, or nothing, or it ended. */
  async start(): Promise<InlineOutcome> {
    const outcome = await this.run.start(this.opts.request.instruction);
    if (outcome === 'cancelled') return { kind: 'cancelled', message: this.lastMessage };
    if (outcome === 'error') return { kind: 'error', message: this.lastMessage };
    if (outcome === 'paused') {
      // The inline agent has no approval-gated tools; a pause means a misconfigured agent.
      await this.run.cancel();
      return {
        kind: 'error',
        message:
          'The inline agent asked for an approval; check trueforge/agents/inline.agent.json.',
      };
    }
    return this.collect();
  }

  private async collect(): Promise<InlineOutcome> {
    const task = this.opts.ctx.tasks.get(this.taskId);
    if (!task) return { kind: 'error', message: 'The inline task ended unexpectedly.' };
    let fallback = false;
    if (task.changeSet.stagedPaths().length === 0) {
      const code = extractFencedCode(this.reply);
      if (code !== undefined) {
        const { request } = this.opts;
        task.changeSet.declareContext({
          plan: ['Replace the selection with the code block from the reply'],
          files: [{ path: request.path, reason: 'inline edit (code block fallback)' }],
        });
        const staged = await task.changeSet.stage({
          kind: 'write',
          path: request.path,
          content: replaceRange(request.text, request.range, code),
        });
        fallback = staged.ok;
        if (!staged.ok) this.opts.logger?.warn(`fenced fallback: ${staged.error.message}`);
      }
    }
    const files = task.changeSet.review().filter((f) => f.blocks.length > 0);
    if (files.length === 0) {
      this.opts.ctx.tasks.cancel(this.taskId);
      const said = tail(this.reply, 120);
      return {
        kind: 'nothing',
        message: said
          ? `No change proposed. The model said: ${said}`
          : 'No change proposed for the selection.',
      };
    }
    const outside = new Map<string, readonly string[]>();
    for (const f of files) {
      const ids = blocksOutside(f.path, f.blocks, this.range);
      if (ids.length > 0) outside.set(f.path, ids);
    }
    const blocks = files.reduce((n, f) => n + f.blocks.length, 0);
    return {
      kind: 'review',
      taskId: this.taskId,
      changeSet: task.changeSet,
      outside,
      fallback,
      message: `${blocks} block(s) to review${fallback ? ' (from a code block in the reply)' : ''}${outside.size > 0 ? '; some change lines outside the selection' : ''}.`,
    };
  }

  /** Escape: the same cancellation as agent mode (blueprint section 8). */
  cancel(): Promise<void> {
    return this.run.cancel();
  }
}
