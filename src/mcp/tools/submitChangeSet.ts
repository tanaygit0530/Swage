import { z } from 'zod';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';
import { symbolWarnings } from './symbolCheck';

/**
 * submit_change_set (blueprint sections 6 and 8): marks the staged change set ready for review.
 * It applies nothing. TrueForge pauses this tool for approval by name; the extension opens the
 * Review view, the user accepts or rejects blocks, and only then does the atomic apply run.
 * Idempotent per change set: a second call returns the first result (rule 7).
 */
export const submitChangeSet: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'submit_change_set',
    {
      title: 'Submit change set',
      description:
        'When every edit is staged (and tests pass), submit the change set for the user to review. Nothing is applied until the user accepts blocks in the Review view.',
      inputSchema: {
        summary: z.string().min(10).max(2000).describe('What changed and why, for the reviewer'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    runTool(ctx, 'submit_change_set', async (args: { summary: string }, call) => {
      const { task } = call;
      if (task.changeSet.status === 'applied') {
        // The user reviewed and applied before approving this call (blueprint section 6, approval flow).
        const r = task.changeSet.result();
        return textResult(
          [
            `The user reviewed the change set and applied it: ${r.accepted.length} block(s) accepted, ${r.rejected.length + r.pending.length} not applied.`,
            ...(r.accepted.length ? [`Accepted: ${r.accepted.join(', ')}`] : []),
            ...(r.rejected.length + r.pending.length
              ? [`Not applied: ${[...r.rejected, ...r.pending].join(', ')}`]
              : []),
            'Do not stage these edits again. If a rejected block mattered, explain why instead.',
          ].join('\n'),
        );
      }
      if (task.submission !== undefined) return textResult(task.submission);
      const files = task.changeSet.review();
      if (files.length === 0) {
        throw new ToolError(
          'nothing_staged',
          'Nothing is staged. Use declare_context and stage_edit first, then submit.',
        );
      }
      const warnings = await symbolWarnings(ctx, task);
      task.changeSet.submit();
      const blocks = files.reduce((n, f) => n + f.blocks.length, 0);
      const text = [
        `Submitted change set ${task.id} for review: ${files.length} file(s), ${blocks} block(s). Nothing has been applied to the workspace.`,
        ...files.map((f) => `- ${f.kind} ${f.path}: ${f.blocks.length} block(s)`),
        ...warnings.map((w) => `Warning for the reviewer: ${w.message}`),
        'The user will accept or reject each block; you will be told the outcome.',
      ].join('\n');
      task.submission = text;
      ctx.events.onSubmit?.(task.id, args.summary);
      return textResult(text);
    }),
  );
};
