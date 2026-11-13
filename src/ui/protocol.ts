import { z } from 'zod';

/**
 * Messages between the extension host and the agent panel webview. Both sides validate every
 * message with these schemas and drop anything malformed, so the webview never trusts the host
 * blindly and the host never acts on an unexpected message (blueprint section 4: the webview only
 * exchanges messages with the host and never sees keys or the MCP token).
 */

const Text = z.string().max(200_000);
const Short = z.string().max(2_000);

export const RunState = z.enum([
  'idle',
  'starting',
  'running',
  'paused',
  'cancelling',
  'cancelled',
  'done',
  'error',
]);
export type RunState = z.infer<typeof RunState>;

export const CompletionItem = z.object({
  kind: z.enum(['file', 'symbol']),
  label: Short,
  detail: Short,
  insertText: Short,
});
export type CompletionItem = z.infer<typeof CompletionItem>;

const Count = z.number().int().min(0);
const Kind = z.enum(['create', 'modify', 'delete']);

/** One file in the files-changed bar, with its change blocks (built by src/ui/changes.ts). */
export const ChangeFile = z.object({
  path: Short,
  kind: Kind,
  added: Count,
  removed: Count,
  decision: z.enum(['pending', 'accepted', 'rejected', 'partial']),
  blocks: z
    .array(
      z.object({
        id: Short,
        state: z.enum(['pending', 'accepted', 'rejected']),
        added: Count,
        removed: Count,
        line: z.number().int().min(1),
        summary: Short,
      }),
    )
    .max(500),
  reason: Short.optional(),
});
export type ChangeFile = z.infer<typeof ChangeFile>;

const FileSummary = z.object({
  path: Short,
  kind: Kind,
  added: Count,
  removed: Count,
  reason: Short.optional(),
});

export const HostToWebview = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    workspace: Short,
    model: Short,
    /** The run mode remembered for this workspace. */
    mode: z.enum(['planning', 'fast']).optional(),
  }),
  /** The run mode changed (or was restored). */
  z.object({ type: z.literal('mode'), mode: z.enum(['planning', 'fast']) }),
  /** The cancelled turn has drained (turn.done arrived): Stop can turn back into Send. */
  z.object({ type: z.literal('drained') }),
  /** Cmd+L / Ctrl+L: focus the composer. */
  z.object({ type: z.literal('focusComposer') }),
  /** Text for the composer from "+" (the selection or the active file as a mention). */
  z.object({ type: z.literal('attachment'), text: Text }),
  /** A failed profile answers again: the fallback banner offers "Switch back". */
  z.object({ type: z.literal('recovered'), name: Short, label: Short }),
  z.object({ type: z.literal('status'), state: RunState, message: Short.optional() }),
  z.object({ type: z.literal('user'), text: Text }),
  z.object({ type: z.literal('text'), messageId: Short, delta: Text }),
  z.object({
    type: z.literal('tool_start'),
    toolCallId: Short,
    name: Short,
    summary: Short,
    /** Redacted, truncated arguments for the expanded row (never shown by default). */
    args: Text.optional(),
  }),
  z.object({
    type: z.literal('tool_end'),
    toolCallId: Short,
    durationMs: z.number().int().min(0),
    resultChars: z.number().int().min(0),
    error: z.boolean(),
    /** A short outcome for the row, such as "12 passed". */
    outcome: Short.optional(),
    /** The start of the result, redacted, for the expanded row. */
    result: Text.optional(),
  }),
  z.object({
    type: z.literal('plan'),
    steps: z.array(Short).max(30),
    files: z.array(z.object({ path: Short, reason: Short })).max(50),
    /** Planning mode: the paused declare_context call this card approves or sends back. */
    toolCallId: Short.optional(),
    awaiting: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('budget'),
    used: z.number().int().min(0),
    total: z.number().int().min(1),
    parts: z.array(z.object({ label: Short, tokens: z.number().int().min(0) })).max(20),
  }),
  z.object({
    type: z.literal('approval'),
    calls: z
      .array(z.object({ toolCallId: Short, threadId: Short, name: Short, summary: Text }))
      .min(1)
      .max(20),
  }),
  z.object({ type: z.literal('approval_resolved'), toolCallId: Short, allowed: z.boolean() }),
  z.object({
    type: z.literal('completions'),
    requestId: z.number().int(),
    items: z.array(CompletionItem).max(50),
  }),
  z.object({ type: z.literal('error'), message: Short }),
  /** A banner in the timeline, for example "Switched to Groq because Gemini returned 429." */
  z.object({
    type: z.literal('notice'),
    tone: z.enum(['info', 'warning', 'error']),
    message: Short,
    /** A fallback banner: the profile name it switched away from (for "Switch back"). */
    switchedFrom: Short.optional(),
  }),
  /** stage_edit added or changed a file: an edited-file card in the thread. */
  z.object({ type: z.literal('edit'), taskId: Short, ...FileSummary.shape }),
  /**
   * The files-changed bar: `staging` while the agent still edits (read-only), `review` once the
   * change set is submitted (decisions apply), `none` when there is nothing to review.
   */
  z.object({
    type: z.literal('changes'),
    phase: z.enum(['none', 'staging', 'review']),
    files: z.array(ChangeFile).max(200),
  }),
  /** The end of a task: the model's summary and the changed files. */
  z.object({
    type: z.literal('walkthrough'),
    summary: Text,
    files: z.array(FileSummary).max(200),
  }),
  /** Accept all applied the change set: the inline "Applied N files. Undo" toast. */
  z.object({ type: z.literal('applied'), files: Count, message: Short }),
  /** The model the run is on now (after a fallback switch). */
  z.object({ type: z.literal('model'), model: Short }),
  /** The model profiles for the panel's model picker, and the active one. */
  z.object({
    type: z.literal('models'),
    active: Short,
    items: z
      .array(z.object({ name: Short, label: Short, model: Short, note: Short.optional() }))
      .max(50),
    /** True when a failure moves the task to the next profile on its own. */
    autoFallback: z.boolean().optional(),
  }),
]);
export type HostToWebview = z.infer<typeof HostToWebview>;

export const WebviewToHost = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('submit'), text: z.string().trim().min(1).max(20_000) }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('retry') }),
  /** The user picked a profile in the panel's model picker. */
  z.object({ type: z.literal('selectModel'), name: Short }),
  /** "Other models…": open Swage: Switch Model (add any TrueForge model, change the primary). */
  z.object({ type: z.literal('moreModels') }),
  z.object({
    type: z.literal('approve'),
    toolCallId: Short,
    allow: z.boolean(),
    reason: Short.optional(),
  }),
  /** A file chip or edited-file card: open the workspace file, optionally at a 1-based line. */
  z.object({ type: z.literal('openFile'), path: Short, line: z.number().int().min(1).optional() }),
  /** The Plan card: Approve, or Edit with feedback (the plan goes back to the agent). */
  z.object({
    type: z.literal('planDecision'),
    toolCallId: Short,
    approve: z.boolean(),
    feedback: z.string().max(4_000).optional(),
  }),
  /** The mode dropdown: Planning waits for plan approval, Fast runs straight through. */
  z.object({ type: z.literal('setMode'), mode: z.enum(['planning', 'fast']) }),
  /** "+": attach the selection (or the active file when nothing is selected). */
  z.object({ type: z.literal('attach'), what: z.enum(['auto', 'file', 'selection']) }),
  /** "Open diff" on a card or a bar row: the native diff, optionally at a block. */
  z.object({ type: z.literal('openDiff'), path: Short, blockId: Short.optional() }),
  /** A per-block or per-file decision in the files-changed bar. */
  z.object({
    type: z.literal('reviewAction'),
    action: z.enum(['acceptBlock', 'rejectBlock', 'splitBlock', 'acceptFile', 'rejectFile']),
    path: Short,
    blockId: Short.optional(),
  }),
  /** Accept all: accept every block and apply atomically. */
  z.object({ type: z.literal('acceptAll') }),
  /** Reject all: discard the change set; the workspace stays unchanged. */
  z.object({ type: z.literal('rejectAll') }),
  /** Apply the blocks accepted so far (after per-file or per-block decisions). */
  z.object({ type: z.literal('applyAccepted') }),
  /** The toast's Undo: swage.undoLastChangeSet. */
  z.object({ type: z.literal('undo') }),
  /** A `name()` chip: go to the symbol's definition. */
  z.object({ type: z.literal('openSymbol'), name: Short }),
  /** A code block's "Insert at cursor". */
  z.object({ type: z.literal('insertCode'), text: Text }),
  /** A code block's "Copy" (the host writes the clipboard; webviews may not). */
  z.object({ type: z.literal('copy'), text: Text }),
  z.object({
    type: z.literal('complete'),
    requestId: z.number().int(),
    query: z.string().max(200),
  }),
]);
export type WebviewToHost = z.infer<typeof WebviewToHost>;

/** Validates a message from the webview; undefined if it is malformed. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  const r = WebviewToHost.safeParse(raw);
  return r.success ? r.data : undefined;
}

/** Validates a message from the host; undefined if it is malformed. */
export function parseHostMessage(raw: unknown): HostToWebview | undefined {
  const r = HostToWebview.safeParse(raw);
  return r.success ? r.data : undefined;
}

/**
 * Parsed tool arguments. A deferred tool is called through TrueForge's `call_tool`
 * (`{ mcp_server, tool_name, input }`, verified in trueforge-core DeferredTool.ts), so the real
 * arguments are in `input`.
 */
export function parseToolArgs(rawArgs: string): Record<string, unknown> | undefined {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    if (
      typeof args['tool_name'] === 'string' &&
      args['input'] !== null &&
      typeof args['input'] === 'object'
    ) {
      return args['input'] as Record<string, unknown>;
    }
    return args;
  } catch {
    return undefined;
  }
}

/** One-line summary of tool arguments for the timeline (never the full content). */
export function summarizeArgs(name: string, rawArgs: string): string {
  const args = parseToolArgs(rawArgs);
  if (!args) return String(rawArgs ?? '').slice(0, 80);
  // A model may leave an argument out: JSON.stringify(undefined) is undefined, not a string.
  const s = (v: unknown): string =>
    typeof v === 'string' ? v : v === undefined ? '' : (JSON.stringify(v) ?? '');
  switch (name) {
    case 'find_relevant_code':
      return `"${s(args['query']).slice(0, 80)}"`;
    case 'read_files':
      return (Array.isArray(args['files']) ? (args['files'] as ({ path?: string } | null)[]) : [])
        .map((f) => f?.path ?? '')
        .join(', ')
        .slice(0, 120);
    case 'stage_edit':
      return `${s(args['kind'])} ${s(args['path'])}`;
    case 'declare_context':
      return `${Array.isArray(args['files']) ? args['files'].length : 0} file(s)`;
    case 'run_tests':
    case 'run_command':
      return s(args['command']).slice(0, 120);
    case 'get_symbol':
      return s(args['name']);
    case 'repo_map':
      return args['path_prefix'] ? s(args['path_prefix']) : 'whole repository';
    case 'submit_change_set':
      return s(args['summary']).slice(0, 120);
    default:
      return Object.keys(args).join(', ').slice(0, 80);
  }
}
