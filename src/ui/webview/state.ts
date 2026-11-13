import type { ChangeFile, CompletionItem, HostToWebview, RunState } from '../protocol';
import { planTransition, type PlanEvent, type PlanGate } from './plan';

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
  | {
      kind: 'plan';
      id: string;
      steps: string[];
      files: { path: string; reason: string }[];
      /** Planning mode: the declare_context call the card decides. */
      toolCallId?: string;
      gate: PlanGate;
    }
  | {
      kind: 'approval';
      id: string;
      threadId: string;
      name: string;
      summary: string;
      decision: 'pending' | 'allowed' | 'denied';
    }
  | {
      kind: 'notice';
      id: string;
      text: string;
      tone: 'info' | 'warning' | 'error';
      /** A fallback banner: the profile it switched away from, and once it recovers, Switch back. */
      switchedFrom?: string;
      switchBack?: { name: string; label: string };
      /** An error banner of a failed run: offer Retry. */
      retry?: boolean;
    }
  | {
      kind: 'edit';
      id: string;
      path: string;
      fileKind: 'create' | 'modify' | 'delete';
      added: number;
      removed: number;
      reason?: string | undefined;
    }
  | {
      kind: 'walkthrough';
      id: string;
      summary: string;
      files: readonly {
        path: string;
        kind: 'create' | 'modify' | 'delete';
        added: number;
        removed: number;
        reason?: string | undefined;
      }[];
    };

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
  /** The files-changed bar. */
  readonly changes: {
    readonly phase: 'none' | 'staging' | 'review';
    readonly files: readonly ChangeFile[];
  };
  /** Planning waits for plan approval before any edit; Fast runs straight through. */
  readonly mode: 'planning' | 'fast';
  /** Stop was pressed and the cancelled turn has not drained yet ("Stopping…"). */
  readonly stopping: boolean;
  /** Profiles fall back on their own (shown as a hint in the model menu). */
  readonly autoFallback: boolean;
  /** Text for the composer from "+", consumed once by the composer. */
  readonly attachment: { readonly id: number; readonly text: string } | undefined;
  /** Bumped by Cmd+L: the composer focuses itself. */
  readonly focusSeq: number;
  /** The inline toast after Accept all ("Applied N files. Undo"). */
  readonly toast:
    { readonly id: number; readonly text: string; readonly undo: boolean } | undefined;
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
  changes: { phase: 'none', files: [] },
  toast: undefined,
  mode: 'planning',
  stopping: false,
  autoFallback: false,
  attachment: undefined,
  focusSeq: 0,
};

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

/** Hides the inline toast (its timer ran out, or the user pressed Undo). */
export function dismissToast(state: PanelState, id: number): PanelState {
  return state.toast?.id === id ? { ...state, toast: undefined } : state;
}

/** Actions the webview dispatches itself, besides host messages. */
export type LocalAction =
  | { readonly type: 'local.dismissToast'; readonly id: number }
  | { readonly type: 'local.plan'; readonly id: string; readonly event: PlanEvent };

export function reducePanel(state: PanelState, action: HostToWebview | LocalAction): PanelState {
  if (action.type === 'local.dismissToast') return dismissToast(state, action.id);
  if (action.type === 'local.plan')
    return {
      ...state,
      timeline: state.timeline.map((t) =>
        t.kind === 'plan' && t.id === action.id
          ? { ...t, gate: planTransition(t.gate, action.event) }
          : t,
      ),
    };
  return reduce(state, action);
}

export function isBusy(state: RunState): boolean {
  return state === 'starting' || state === 'running' || state === 'cancelling';
}

export function reduce(state: PanelState, msg: HostToWebview): PanelState {
  switch (msg.type) {
    case 'init':
      return {
        ...state,
        workspace: msg.workspace,
        model: msg.model,
        ...(msg.mode ? { mode: msg.mode } : {}),
      };
    case 'mode':
      return { ...state, mode: msg.mode };
    case 'drained':
      return { ...state, stopping: false };
    case 'focusComposer':
      return { ...state, focusSeq: state.focusSeq + 1 };
    case 'attachment':
      return {
        ...state,
        attachment: { id: (state.attachment?.id ?? 0) + 1, text: msg.text },
      };
    case 'recovered': {
      // Offer "Switch back" on the latest banner that switched away from this profile.
      let i = -1;
      state.timeline.forEach((t, k) => {
        if (t.kind === 'notice' && t.switchedFrom === msg.name) i = k;
      });
      if (i < 0) return state;
      const timeline = [...state.timeline];
      const item = timeline[i];
      if (item?.kind === 'notice')
        timeline[i] = { ...item, switchBack: { name: msg.name, label: msg.label } };
      return { ...state, timeline };
    }
    case 'status': {
      // Tools still running when a run stops are marked stopped.
      const stopped = msg.state === 'cancelled' || msg.state === 'error' || msg.state === 'done';
      const timeline = stopped
        ? state.timeline.map((t) =>
            t.kind === 'tool' && t.status === 'running'
              ? { ...t, status: 'stopped' as const }
              : t.kind === 'plan'
                ? { ...t, gate: planTransition(t.gate, 'runEnded') }
                : t,
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
                ...(msg.state === 'error' ? { retry: true } : {}),
              },
            ]
          : [];
      return {
        ...state,
        status: msg.state,
        statusMessage: msg.message ?? '',
        timeline: [...timeline, ...notice],
        // Stop flips the UI at once; the button says "Stopping…" until the turn has drained.
        stopping:
          msg.state === 'cancelled'
            ? state.status !== 'cancelled' || state.stopping
            : msg.state === 'starting'
              ? false
              : state.stopping,
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
          {
            kind: 'plan',
            id: msg.toolCallId ? `plan-${msg.toolCallId}` : nextId('p'),
            steps: msg.steps,
            files: msg.files,
            ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
            gate: msg.awaiting ? 'awaiting' : 'view',
          },
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
            : t.kind === 'plan' && t.toolCallId === msg.toolCallId
              ? { ...t, gate: planTransition(t.gate, msg.allowed ? 'allowed' : 'denied') }
              : t,
        ),
      };
    case 'completions':
      return msg.requestId >= state.completions.requestId
        ? { ...state, completions: { requestId: msg.requestId, items: msg.items } }
        : state;
    case 'notice': {
      const from = msg.switchedFrom;
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: 'notice',
            id: nextId('n'),
            text: msg.message,
            tone: msg.tone,
            ...(from ? { switchedFrom: from } : {}),
          },
        ],
      };
    }
    case 'model':
      return { ...state, model: msg.model };
    case 'models': {
      const active = msg.items.find((m) => m.name === msg.active);
      return {
        ...state,
        models: { active: msg.active, items: msg.items },
        autoFallback: msg.autoFallback ?? state.autoFallback,
        model: active ? `${active.label} (${active.model})` : state.model,
      };
    }
    case 'edit': {
      const id = `edit-${msg.taskId}-${msg.path}`;
      const item: TimelineItem = {
        kind: 'edit',
        id,
        path: msg.path,
        fileKind: msg.kind,
        added: msg.added,
        removed: msg.removed,
        ...(msg.reason === undefined ? {} : { reason: msg.reason }),
      };
      // A file staged again in the same task updates its card instead of adding another.
      return state.timeline.some((t) => t.id === id)
        ? { ...state, timeline: state.timeline.map((t) => (t.id === id ? item : t)) }
        : { ...state, timeline: [...state.timeline, item] };
    }
    case 'changes':
      return { ...state, changes: { phase: msg.phase, files: msg.files } };
    case 'walkthrough':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'walkthrough', id: nextId('w'), summary: msg.summary, files: msg.files },
        ],
      };
    case 'applied':
      return {
        ...state,
        changes: { phase: 'none', files: [] },
        toast: {
          id: (state.toast?.id ?? 0) + 1,
          text: `Applied ${msg.files} file${msg.files === 1 ? '' : 's'}.`,
          undo: true,
        },
      };
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
