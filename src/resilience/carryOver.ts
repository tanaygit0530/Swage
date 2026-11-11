import type { ReviewFile } from '../changeset/changeSet';

/**
 * The first message on a fallback profile (blueprint section 8: "the new session starts from the
 * task plus the current staged diff"). The task id, and so the change set, stays the same: the
 * new model sees what is already staged through read_files and continues from there.
 */

export interface CarryOver {
  /** The first message of the task, as the failed model received it. */
  readonly original: string;
  /** "Gemini returned 429". */
  readonly why: string;
  readonly plan: readonly string[];
  readonly files: readonly { readonly path: string; readonly reason: string }[];
  readonly staged: readonly ReviewFile[];
}

/** Sent when retrying on the same profile after the model already did some work. */
export const CONTINUE_MESSAGE =
  'The previous model request failed before it finished. Continue the task from where you stopped; edits staged so far are kept (read_files shows them).';

export function carryOverMessage(c: CarryOver): string {
  const lines = [
    `This task moved to a different model because ${c.why}. The workspace has not changed; staged edits are kept in the change set.`,
    '',
    c.original,
  ];
  const progress: string[] = [];
  if (c.plan.length > 0)
    progress.push('Plan declared so far:', ...c.plan.map((s, i) => `${i + 1}. ${s}`));
  if (c.files.length > 0)
    progress.push('Declared files:', ...c.files.map((f) => `- ${f.path}: ${f.reason}`));
  const staged = c.staged.filter((f) => f.blocks.length > 0);
  if (staged.length > 0) {
    progress.push(
      'Already staged (do not stage these changes again; read_files shows the staged content):',
      ...staged.map((f) => {
        const added = f.blocks.reduce((n, b) => n + b.newLines.length, 0);
        const removed = f.blocks.reduce((n, b) => n + b.oldLines.length, 0);
        return `- ${f.path}: ${f.kind}, ${f.blocks.length} block(s), +${added} -${removed}`;
      }),
    );
  }
  if (progress.length > 0) {
    lines.push(
      '',
      'Progress before the switch:',
      ...progress,
      '',
      'Continue from here: do what is still missing, then finish as the workflow says.',
    );
  } else {
    lines.push('', 'Nothing was staged before the switch; start the task from the beginning.');
  }
  return lines.join('\n');
}
