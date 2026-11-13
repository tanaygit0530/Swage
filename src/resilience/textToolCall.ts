/**
 * Some models, often small local ones behind an OpenAI-compatible endpoint, answer with a tool
 * call written out as text (`{"name": "stage_edit", "arguments": {...}}`) instead of calling the
 * tool. TrueForge then sees a plain reply and the turn ends with nothing done. Swage does not run
 * such text itself (the agent loop stays on TrueForge); it treats the model as unable to call
 * tools here and moves the task to the next profile.
 */

const CALL =
  /\{\s*"(?:name|tool|function)"\s*:\s*"([A-Za-z_][\w.-]*)"\s*,\s*"(?:arguments|parameters|args|input)"\s*:/g;

/** The tool names a reply wrote out as text calls, if any (only names the agent could call). */
export function textToolCalls(reply: string, toolNames: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of reply.matchAll(CALL)) if (m[1] && toolNames.has(m[1])) out.push(m[1]);
  return out;
}

/** Swage's editor tools and TrueForge's deferred-tool helpers. */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'find_relevant_code',
  'repo_map',
  'read_files',
  'get_symbol',
  'declare_context',
  'stage_edit',
  'run_tests',
  'run_command',
  'submit_change_set',
  'call_tool',
  'list_tools',
  'get_tool_info',
]);
