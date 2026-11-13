import type { CompletionItem, HostToWebview, RunState } from '../protocol';

/**
 * The agent panel's state: a pure reducer over host messages, so the UI logic is testable
 * without a DOM or VS Code.
 */

export type TimelineItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      status: 'running' | 'ok' | 'error' | 'stopped';
      durationMs?: number;
      resultChars?: number;
      /** Redacted, truncated arguments and result for the expanded row. */
      args?: string;
      outcome?: string;
      result?: string;
    }
  | { kind: 'plan'; id: string; steps: string[]; files: { path: string; reason: string }[] }
  | {
      kind: 'approval';
      id: string;
      threadId: string;
      name: string;
      summary: string;
      decision: 'pending' | 'allowed' | 'denied';
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warning' | 'error' };

export interface PanelState {
  readonly workspace: string;
  readonly model: string;
  /** The model picker: profiles and the active one. */
  readonly models: {
    readonly active: string;
    readonly items: readonly {
      name: string;
      label: string;
      model: string;
      note?: string | undefined;
    }[];
  };
  readonly status: RunState;
  readonly statusMessage: string;
  readonly timeline: readonly TimelineItem[];
  readonly budget:
    { used: number; total: number; parts: { label: string; tokens: number }[] } | undefined;
  readonly completions: { requestId: number; items: CompletionItem[] };
}

export const initialState: PanelState = {
  workspace: '',
  model: '',
  models: { active: '', items: [] },
  status: 'idle',
  statusMessage: '',
  timeline: [],
  budget: undefined,
  completions: { requestId: -1, items: [] },
};

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

export function isBusy(state: RunState): boolean {
  return state === 'starting' || state === 'running' || state === 'cancelling';
}

export function reduce(state: PanelState, msg: HostToWebview): PanelState {
  switch (msg.type) {
    case 'init':
      return { ...state, workspace: msg.workspace, model: msg.model };
    case 'status': {
      // Tools still running when a run stops are marked stopped.
      const stopped = msg.state === 'cancelled' || msg.state === 'error' || msg.state === 'done';
      const timeline = stopped
        ? state.timeline.map((t) =>
            t.kind === 'tool' && t.status === 'running' ? { ...t, status: 'stopped' as const } : t,
          )
        : state.timeline;
      const notice: TimelineItem[] =
        msg.message && (msg.state === 'cancelled' || msg.state === 'error' || msg.state === 'done')
          ? [
              {
                kind: 'notice',
                id: nextId('n'),
                text: msg.message,
                tone: msg.state === 'error' ? 'error' : 'info',
              },
            ]
          : [];
      return {
        ...state,
        status: msg.state,
        statusMessage: msg.message ?? '',
        timeline: [...timeline, ...notice],
      };
    }
    case 'user':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'user', id: nextId('u'), text: msg.text }],
      };
    case 'text': {
      const last = state.timeline.at(-1);
      if (last?.kind === 'assistant' && last.id === msg.messageId) {
        return {
          ...state,
          timeline: [...state.timeline.slice(0, -1), { ...last, text: last.text + msg.delta }],
        };
      }
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'assistant', id: msg.messageId, text: msg.delta }],
      };
    }
    case 'tool_start':
      if (state.timeline.some((t) => t.kind === 'tool' && t.id === msg.toolCallId)) return state;
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: 'tool',
            id: msg.toolCallId,
            name: msg.name,
            summary: msg.summary,
            status: 'running',
            ...(msg.args === undefined ? {} : { args: msg.args }),
          },
        ],
      };
    case 'tool_end':
      return {
        ...state,
        timeline: state.timeline.map((t) =>
          t.kind === 'tool' && t.id === msg.toolCallId
            ? {
                ...t,
                status: msg.error ? 'error' : 'ok',
                durationMs: msg.durationMs,
                resultChars: msg.resultChars,
                ...(msg.outcome === undefined ? {} : { outcome: msg.outcome }),
                ...(msg.result === undefined ? {} : { result: msg.result }),
              }
            : t,
        ),
      };
    case 'plan':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'plan', id: nextId('p'), steps: msg.steps, files: msg.files },
        ],
      };
    case 'budget':
      return { ...state, budget: { used: msg.used, total: msg.total, parts: msg.parts } };
    case 'approval':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          ...msg.calls.map((c): TimelineItem => ({
            kind: 'approval',
            id: c.toolCallId,
            threadId: c.threadId,
            name: c.name,
            summary: c.summary,
            decision: 'pending',
          })),
        ],
      };
    case 'approval_resolved':
      return {
        ...state,
        timeline: state.timeline.map((t) =>
          t.kind === 'approval' && t.id === msg.toolCallId
            ? { ...t, decision: msg.allowed ? 'allowed' : 'denied' }
            : t,
        ),
      };
    case 'completions':
      return msg.requestId >= state.completions.requestId
        ? { ...state, completions: { requestId: msg.requestId, items: msg.items } }
        : state;
    case 'notice':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'notice', id: nextId('n'), text: msg.message, tone: msg.tone },
        ],
      };
    case 'model':
      return { ...state, model: msg.model };
    case 'models': {
      const active = msg.items.find((m) => m.name === msg.active);
      return {
        ...state,
        models: { active: msg.active, items: msg.items },
        model: active ? `${active.label} (${active.model})` : state.model,
      };
    }
    case 'error':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'notice', id: nextId('n'), text: msg.message, tone: 'error' },
        ],
      };
  }
}

/** The `@` query at the cursor, if the user is typing a mention. */
export function mentionQuery(
  text: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor);
  const m = /(^|[\s(["'`])@((?:file:|symbol:)?[\w$./\\-]*)$/.exec(before);
  if (!m) return undefined;
  const query = m[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

/** Replaces the mention at the cursor with the chosen completion. */
export function applyCompletion(
  text: string,
  cursor: number,
  insertText: string,
): { text: string; cursor: number } {
  const q = mentionQuery(text, cursor);
  if (!q) return { text, cursor };
  const next = `${text.slice(0, q.start)}${insertText} ${text.slice(cursor)}`;
  return { text: next, cursor: q.start + insertText.length + 1 };
}
