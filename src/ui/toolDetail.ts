import { redactText } from '../safety/redact';
import { parseToolArgs } from './protocol';

/**
 * What the agent panel shows about one tool call (redesign step 2): never raw JSON in the
 * thread, only a one-line row; the expanded row shows the arguments and the start of the
 * result, both redacted (CLAUDE.md: redact secrets in any tool output) and truncated.
 */

export const ARGS_PREVIEW_CHARS = 1_500;
export const RESULT_PREVIEW_CHARS = 600;
const STRING_CHARS = 200;

/**
 * The tool the model really called. A deferred tool goes through TrueForge's `call_tool`
 * (`{ mcp_server, tool_name, input }`), so the row names the inner tool.
 */
export function effectiveToolName(name: string, rawArgs: string): string {
  if (name !== 'call_tool') return name;
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    return typeof args['tool_name'] === 'string' ? args['tool_name'] : name;
  } catch {
    return name;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

/** The arguments, pretty-printed, with long strings (file contents, edits) shortened. */
export function argsPreview(rawArgs: string): string {
  const args = parseToolArgs(rawArgs);
  if (!args) return redactText(clip(rawArgs, ARGS_PREVIEW_CHARS));
  const shorten = (_key: string, value: unknown): unknown =>
    typeof value === 'string' && value.length > STRING_CHARS
      ? `${value.slice(0, STRING_CHARS)}… (${value.length} chars)`
      : value;
  return redactText(clip(JSON.stringify(args, shorten, 2), ARGS_PREVIEW_CHARS));
}

/** The first part of a tool result, redacted. */
export function resultPreview(content: string): string {
  return redactText(clip(content.trim(), RESULT_PREVIEW_CHARS));
}

/** A short outcome for the row, such as "12 passed" or "exit 1"; undefined when nothing fits. */
export function toolOutcome(name: string, content: string, error: boolean): string | undefined {
  if (name === 'run_tests' || name === 'run_command') {
    const passed = /(\d+) passed/.exec(content)?.[1];
    const failed = /(\d+) failed/.exec(content)?.[1];
    const parts = [
      ...(passed ? [`${passed} passed`] : []),
      ...(failed ? [`${failed} failed`] : []),
    ];
    if (parts.length > 0) return parts.join(', ');
    const exit = /Exit code (\d+)/.exec(content)?.[1];
    if (exit !== undefined) return `exit ${exit}`;
    return error ? 'failed' : undefined;
  }
  if (error) {
    const code = /"code"\s*:\s*"([\w-]+)"/.exec(content)?.[1];
    return code ? code.replace(/_/g, ' ') : 'failed';
  }
  if (name === 'find_relevant_code') {
    const n = content.match(/^\d+\. \S+ \(score /gm)?.length;
    return n ? `${n} results` : undefined;
  }
  return undefined;
}
