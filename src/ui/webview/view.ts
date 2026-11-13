import type { PanelState, TimelineItem } from './state';

/**
 * Small view rules for the thread (redesign step 7), kept pure for tests: when to show the
 * thinking dots and the streaming caret, how an approval card reads, and when auto-scroll
 * follows the thread.
 */

const BUSY = new Set(['starting', 'running']);

/** Thinking: the run is working but nothing is streaming and no tool row is spinning. */
export function isThinking(state: Pick<PanelState, 'status' | 'timeline'>): boolean {
  if (!BUSY.has(state.status)) return false;
  const last = state.timeline.at(-1);
  if (!last) return true;
  if (last.kind === 'assistant') return false;
  return !state.timeline.some((t) => t.kind === 'tool' && t.status === 'running');
}

/** The assistant message that is streaming right now (it gets a caret), if any. */
export function streamingId(state: Pick<PanelState, 'status' | 'timeline'>): string | undefined {
  const last = state.timeline.at(-1);
  return state.status === 'running' && last?.kind === 'assistant' ? last.id : undefined;
}

export interface ApprovalView {
  readonly title: string;
  /** The exact command or summary, shown verbatim. */
  readonly body: string;
  readonly reason?: string | undefined;
  readonly allow: string;
  readonly deny: string;
}

export function approvalView(item: Extract<TimelineItem, { kind: 'approval' }>): ApprovalView {
  const [first = '', ...rest] = item.summary.split('\n');
  if (item.name === 'run_command') {
    const reason = rest
      .find((l) => l.startsWith('Reason: '))
      ?.slice('Reason: '.length)
      .trim();
    return {
      title: 'Run this command?',
      body: first,
      ...(reason ? { reason } : {}),
      allow: 'Allow',
      deny: 'Deny',
    };
  }
  if (item.name === 'submit_change_set')
    return {
      title: 'Review the change set',
      body: item.summary,
      allow: 'Apply accepted',
      deny: 'Discard',
    };
  return { title: `Allow ${item.name}?`, body: item.summary, allow: 'Allow', deny: 'Deny' };
}

/** Auto-scroll follows the thread only while the user is at (or near) the bottom. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slack = 48,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}
