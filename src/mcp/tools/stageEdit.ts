import { z } from 'zod';
import type { StageInput } from '../../changeset/changeSet';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';
import { rangeWarning } from '../../inline/rangeLock';
import { symbolWarnings } from './symbolCheck';

/**
 * stage_edit (blueprint section 6): edit, create or delete a file inside the in-memory change
 * set. Nothing is written to disk; the user reviews every block before apply. Change-set
 * errors (anchor_not_found, anchor_ambiguous, bad_occurrence, undeclared_file,
 * suspicious_truncation, ...) come back as structured codes the agent can act on.
 */

const Edit = z.object({
  find: z.string().describe('Exact text currently in the file, copied from read_files'),
  replace: z.string().describe('Replacement text'),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Which match to replace when find occurs more than once'),
});

interface Args {
  path: string;
  kind: 'edit' | 'write' | 'delete';
  edits?: z.infer<typeof Edit>[] | undefined;
  content?: string | undefined;
}

export const stageEdit: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'stage_edit',
    {
      title: 'Stage edit',
      description:
        'Stage a change in memory for review: kind "edit" with find/replace edits (preferred), "write" with the complete new content (creates the file if new), or "delete". Never writes to disk. Call declare_context first.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path, declared with declare_context'),
        kind: z.enum(['edit', 'write', 'delete']),
        edits: z
          .array(Edit)
          .min(1)
          .max(20)
          .optional()
          .describe('For kind "edit"; applied in order, all or nothing'),
        content: z
          .string()
          .max(400_000)
          .optional()
          .describe('For kind "write": the complete file content'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(ctx, 'stage_edit', async (args: Args, call) => {
      const resolved = ctx.guard.resolve(args.path);
      if (!resolved.ok) throw new ToolError(resolved.code, resolved.message, { path: args.path });
      const path = resolved.relative;

      let input: StageInput;
      if (args.kind === 'edit') {
        if (!args.edits)
          throw new ToolError('invalid_input', 'kind "edit" needs edits: [{ find, replace }].');
        input = {
          kind: 'edit',
          path,
          edits: args.edits.map((e) => ({
            find: e.find,
            replace: e.replace,
            ...(e.occurrence === undefined ? {} : { occurrence: e.occurrence }),
          })),
        };
      } else if (args.kind === 'write') {
        if (args.content === undefined)
          throw new ToolError(
            'invalid_input',
            'kind "write" needs content with the complete file.',
          );
        input = { kind: 'write', path, content: args.content };
      } else {
        input = { kind: 'delete', path };
      }

      const result = await call.task.changeSet.stage(input);
      if (!result.ok) {
        const { code, message, editIndex, matchCount } = result.error;
        throw new ToolError(code, message, {
          path,
          ...(editIndex === undefined ? {} : { edit_index: editIndex }),
          ...(matchCount === undefined ? {} : { match_count: matchCount }),
        });
      }
      ctx.events.onStage?.(call.task.id, path);

      const warnings = await symbolWarnings(ctx, call.task);
      const s = result.value;
      const staged = call.task.changeSet.review().find((f) => f.path === s.path);
      const outside = rangeWarning(s.path, staged?.blocks ?? [], call.task.editableRange);
      const lines = [
        s.blockCount === 0
          ? `No change: the staged content of ${s.path} equals the file on disk.`
          : `Staged ${s.kind} of ${s.path}: ${s.blockCount} block(s), +${s.linesAdded} -${s.linesRemoved} lines. Nothing is written to disk until the user reviews and accepts.`,
        ...(outside === undefined ? [] : [`Warning: ${outside}`]),
        ...warnings.map((w) => `Warning: ${w.message}`),
        `Staged so far: ${call.task.changeSet.stagedPaths().join(', ') || 'nothing'}.`,
      ];
      return textResult(lines.join('\n'));
    }),
  );
};
