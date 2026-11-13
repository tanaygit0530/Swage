/**
 * One readable line per tool call (redesign step 2): "Searched code: flask session cookies",
 * "Read 3 files", "Ran tests (12 passed)". The row never shows raw JSON; the expanded row
 * shows the redacted arguments and result the host sent.
 */

export interface ToolLine {
  readonly name: string;
  readonly summary: string;
  readonly status: 'running' | 'ok' | 'error' | 'stopped';
  readonly outcome?: string | undefined;
}

function count(list: string): number {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function toolLabel(t: ToolLine): string {
  const running = t.status === 'running';
  const tail = t.outcome ? ` (${t.outcome})` : '';
  const s = t.summary;
  switch (t.name) {
    case 'find_relevant_code':
      return `${running ? 'Searching' : 'Searched'} code: ${s.replace(/^"|"$/g, '')}${tail}`;
    case 'read_files': {
      const n = count(s);
      return `${running ? 'Reading' : 'Read'} ${n > 0 ? plural(n, 'file') : 'files'}${tail}`;
    }
    case 'get_symbol':
      return `${running ? 'Looking up' : 'Looked up'} ${s}${tail}`;
    case 'repo_map':
      return `${running ? 'Mapping' : 'Mapped'} ${s}${tail}`;
    case 'declare_context':
      return `${running ? 'Declaring' : 'Declared'} the plan: ${s}${tail}`;
    case 'stage_edit':
      return `${running ? 'Staging' : 'Staged'} ${s.replace(/^(edit|write|delete) /, (_m, k: string) => (k === 'write' ? 'a write to ' : k === 'delete' ? 'a delete of ' : 'an edit to '))}${tail}`;
    case 'run_tests':
      return `${running ? 'Running tests' : 'Ran tests'}${tail}${s ? `: ${s}` : ''}`;
    case 'run_command':
      return `${running ? 'Running' : 'Ran'} ${s}${tail}`;
    case 'submit_change_set':
      return `${running ? 'Submitting' : 'Submitted'} the change set${tail}`;
    case 'list_tools':
      return `${running ? 'Listing' : 'Listed'} the editor tools${tail}`;
    case 'get_tool_info':
      return `${running ? 'Reading' : 'Read'} a tool's description${s ? `: ${s}` : ''}${tail}`;
    default:
      return `${t.name}${s ? `: ${s}` : ''}${tail}`;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
