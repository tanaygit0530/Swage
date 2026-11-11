import { isEventDelta, mergeEventDelta, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * Typed events for the UI (blueprint sections 4 and 8), built from TrueForge turn events.
 * Verified against @truefoundry/trueforge-sdk 0.184.1 (see docs/SPIKES.md):
 * - Model output arrives as an empty `model.message` base followed by `model.message.delta`
 *   events with the same `id`; `mergeEventDelta` rebuilds the message, tool-call fragments included.
 * - `tool.response` carries `toolCallId` and `content`.
 * - `tool.approval_required` lists `{ id, sourceEventId }`; the name and arguments live in the
 *   `model.message` with that id.
 * - `turn.done` ends every stream with `state.status` `done` (with `requiredActions`),
 *   `cancelled` (with `reason`) or `error` (with `message`).
 */

export interface PendingToolCall {
  readonly threadId: string;
  readonly toolCallId: string;
  readonly sourceEventId: string;
  readonly name: string;
  /** Raw JSON arguments as the model produced them. */
  readonly arguments: string;
  readonly server?: string;
}

export type SwageEvent =
  | { readonly type: 'turn_started'; readonly turnId: string }
  | {
      readonly type: 'text';
      readonly threadId: string;
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: 'tool_start';
      readonly threadId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: string;
      readonly server?: string;
    }
  | {
      readonly type: 'tool_result';
      readonly threadId: string;
      readonly toolCallId: string;
      readonly content: string;
    }
  | { readonly type: 'approval_required'; readonly calls: readonly PendingToolCall[] }
  | {
      readonly type: 'done';
      /** Final assistant text, empty when the turn ended paused. */
      readonly output: string;
      readonly paused: boolean;
      readonly pending: readonly PendingToolCall[];
      readonly totalTokens?: number;
    }
  | { readonly type: 'cancelled'; readonly reason: string }
  | { readonly type: 'error'; readonly message: string };

type RawEvent = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;

function textOf(content: ModelMessage['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Turns raw TrueForge events into SwageEvents. Keeps the id-keyed event index the SDK
 * docs recommend, so approval refs can be resolved to tool names and arguments.
 */
export class TurnEventMapper {
  private readonly index = new Map<string, RawEvent>();
  private readonly startedTools = new Set<string>();
  private readonly pendingApprovals: PendingToolCall[] = [];
  turnId: string | undefined;

  /** The merged model message for an event id, if seen. */
  message(id: string): ModelMessage | undefined {
    const e = this.index.get(id);
    return e?.type === 'model.message' ? e : undefined;
  }

  private resolveRef(threadId: string, ref: TrueForgeApi.ToolCallRef): PendingToolCall {
    const call = this.message(ref.sourceEventId)?.toolCalls?.find((c) => c.id === ref.id);
    const server = call?.toolInfo.type === 'mcp' ? call.toolInfo.serverName : undefined;
    return {
      threadId,
      toolCallId: ref.id,
      sourceEventId: ref.sourceEventId,
      name: call?.toolInfo.name ?? call?.function.name ?? 'unknown',
      arguments: call?.function.arguments ?? '{}',
      ...(server === undefined ? {} : { server }),
    };
  }

  private toolStarts(msg: ModelMessage): SwageEvent[] {
    const out: SwageEvent[] = [];
    for (const call of msg.toolCalls ?? []) {
      if (!call.id || this.startedTools.has(call.id)) continue;
      this.startedTools.add(call.id);
      const server = call.toolInfo.type === 'mcp' ? call.toolInfo.serverName : undefined;
      out.push({
        type: 'tool_start',
        threadId: msg.threadId,
        toolCallId: call.id,
        name: call.toolInfo.name,
        arguments: call.function.arguments,
        ...(server === undefined ? {} : { server }),
      });
    }
    return out;
  }

  map(event: RawEvent): SwageEvent[] {
    if (isEventDelta(event)) {
      const base = this.index.get(event.id);
      if (base) mergeEventDelta(base, event);
      const out: SwageEvent[] = [];
      if (typeof event.content === 'string' && event.content !== '') {
        out.push({
          type: 'text',
          threadId: event.threadId,
          messageId: event.id,
          delta: event.content,
        });
      }
      // Tool calls are complete once the model reports why it stopped.
      if (
        event.finishReason !== undefined &&
        event.finishReason !== null &&
        base?.type === 'model.message'
      ) {
        out.push(...this.toolStarts(base));
      }
      return out;
    }

    this.index.set(event.id, event);
    switch (event.type) {
      case 'turn.created':
        this.turnId = event.turnId;
        return [{ type: 'turn_started', turnId: event.turnId }];
      case 'model.message': {
        const out: SwageEvent[] = [];
        const text = textOf(event.content);
        if (text !== '')
          out.push({ type: 'text', threadId: event.threadId, messageId: event.id, delta: text });
        if (event.finishReason !== undefined && event.finishReason !== null)
          out.push(...this.toolStarts(event));
        return out;
      }
      case 'tool.response':
        return [
          {
            type: 'tool_result',
            threadId: event.threadId,
            toolCallId: event.toolCallId,
            content: event.content,
          },
        ];
      case 'tool.approval_required': {
        const calls = event.toolCalls.map((ref) => this.resolveRef(event.threadId, ref));
        this.pendingApprovals.push(...calls);
        return [{ type: 'approval_required', calls }];
      }
      case 'turn.done': {
        const state = event.state;
        if (state.status === 'cancelled') return [{ type: 'cancelled', reason: state.reason }];
        if (state.status === 'error') return [{ type: 'error', message: state.message }];
        const pending: PendingToolCall[] = [];
        for (const action of state.requiredActions) {
          if (action.type === 'tool.approval_required') {
            pending.push(...action.toolCalls.map((ref) => this.resolveRef(action.threadId, ref)));
          }
        }
        const total = state.metrics?.totalTokens;
        return [
          {
            type: 'done',
            output: textOf(state.output?.content),
            paused: state.requiredActions.length > 0,
            pending: pending.length > 0 ? pending : [...this.pendingApprovals],
            ...(total === undefined ? {} : { totalTokens: total }),
          },
        ];
      }
      default:
        return [];
    }
  }
}
