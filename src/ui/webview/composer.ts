import type { CompletionItem, RunState } from '../protocol';

/**
 * The composer's logic (redesign step 5), kept pure so it is testable without a DOM: the "/"
 * workflow popup, fuzzy ranking for both popups, the placeholder, and what the round button is
 * (Send, Stop, or "Stopping…" until the cancelled turn has drained).
 */

export interface Workflow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly template: string;
  /** Ask the host to attach the active file or the selection after inserting the template. */
  readonly attach?: 'file' | 'selection';
}

export const WORKFLOWS: readonly Workflow[] = [
  {
    id: 'explain',
    label: 'Explain this file',
    description: 'What the active file does and how its parts fit together',
    template: 'Explain what this file does, its main functions and how they fit together:',
    attach: 'file',
  },
  {
    id: 'fix-test',
    label: 'Fix failing test',
    description: 'Run the tests, find the failure, fix the code',
    template:
      'Run the tests, find the failing test, explain the cause, and fix the code (not the test) so it passes.',
  },
  {
    id: 'add-tests',
    label: 'Add tests',
    description: 'Unit tests for the active file',
    template:
      'Add unit tests for this file that cover the main paths and edge cases, following the existing test style:',
    attach: 'file',
  },
  {
    id: 'docstrings',
    label: 'Write docstrings',
    description: 'Docstrings for public functions and classes',
    template:
      'Write clear docstrings for the public functions and classes in this file, in the project’s existing style:',
    attach: 'file',
  },
  {
    id: 'refactor',
    label: 'Refactor selection',
    description: 'Simplify the selected code without changing behaviour',
    template:
      'Refactor this code to be simpler and clearer without changing its behaviour, and keep the tests passing:',
    attach: 'selection',
  },
];

/**
 * Fuzzy match: every query character in order, case-insensitive. Higher is better; -1 when it
 * does not match. Consecutive characters, word starts and an early first match score more.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let best = -1;
  // Try every place the first character occurs and keep the best greedy match from there.
  for (let start = t.indexOf(q[0] ?? ''); start >= 0; start = t.indexOf(q[0] ?? '', start + 1)) {
    let score = 0;
    let ti = start;
    let prev = -2;
    let ok = true;
    for (const ch of q) {
      const at = t.indexOf(ch, ti);
      if (at < 0) {
        ok = false;
        break;
      }
      score += 1;
      if (at === prev + 1) score += 3;
      if (at === 0 || /[\s/._-]/.test(t[at - 1] ?? '')) score += 2;
      prev = at;
      ti = at + 1;
    }
    if (!ok) break;
    best = Math.max(best, score - Math.min(start, 10) * 0.1);
  }
  return best;
}

/** Ranks items by fuzzy score on their label (ties keep the given order); drops non-matches. */
export function rankFuzzy<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, text(item)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/** The `/` query when the user is typing a workflow at the start of a line. */
export function slashQuery(
  text: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor);
  const m = /(^|\n)\/([\w -]{0,40})$/.exec(before);
  if (!m) return undefined;
  const query = m[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

export function workflowsFor(query: string): Workflow[] {
  return rankFuzzy(WORKFLOWS, query.trim(), (w) => w.label);
}

/** Replaces the `/query` at the cursor with a workflow's template. */
export function applyWorkflow(
  text: string,
  cursor: number,
  workflow: Workflow,
): { text: string; cursor: number } {
  const q = slashQuery(text, cursor);
  if (!q) return { text, cursor };
  const next = `${text.slice(0, q.start)}${workflow.template} ${text.slice(cursor)}`;
  return { text: next, cursor: q.start + workflow.template.length + 1 };
}

/** Mention completions from the host, re-ranked by fuzzy match on the typed query. */
export function rankCompletions(items: readonly CompletionItem[], query: string): CompletionItem[] {
  const q = query.replace(/^(file|symbol):/, '');
  if (!q) return [...items];
  const ranked = rankFuzzy(items, q, (c) => c.label);
  // The host already matched on more than the label (paths, containers): keep the rest after.
  return [...ranked, ...items.filter((c) => !ranked.includes(c))];
}

export function placeholder(mac: boolean): string {
  return `Ask anything (${mac ? 'Cmd' : 'Ctrl'}+L), @ to mention, / for workflows`;
}

export type SendButton = 'send' | 'stop' | 'stopping';

/**
 * Send when idle; Stop while a run is starting, running or waiting for approval; "Stopping…"
 * after Stop until the cancelled turn has drained (turn.done arrived).
 */
export function sendButton(status: RunState, stopping: boolean): SendButton {
  if (stopping || status === 'cancelling') return 'stopping';
  return status === 'starting' || status === 'running' || status === 'paused' ? 'stop' : 'send';
}

/** Lines the textarea shows: grows with the text, between 1 and 10. */
export function rowsFor(text: string): number {
  return Math.min(10, Math.max(1, text.split('\n').length));
}
