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

export const HostToWebview = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), workspace: Short, model: Short }),
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
  }),
  /** The model the run is on now (after a fallback switch). */
  z.object({ type: z.literal('model'), model: Short }),
  /** The model profiles for the panel's model picker, and the active one. */
  z.object({
    type: z.literal('models'),
    active: Short,
    items: z
      .array(z.object({ name: Short, label: Short, model: Short, note: Short.optional() }))
      .max(50),
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
  if (!args) return rawArgs.slice(0, 80);
  const s = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (name) {
    case 'find_relevant_code':
      return `"${s(args['query']).slice(0, 80)}"`;
    case 'read_files':
      return ((args['files'] as { path?: string }[] | undefined) ?? [])
        .map((f) => f.path ?? '')
        .join(', ')
        .slice(0, 120);
    case 'stage_edit':
      return `${s(args['kind'])} ${s(args['path'])}`;
    case 'declare_context':
      return `${((args['files'] as unknown[] | undefined) ?? []).length} file(s)`;
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
