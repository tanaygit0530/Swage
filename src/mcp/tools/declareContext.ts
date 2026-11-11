import { z } from 'zod';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';

/**
 * declare_context (blueprint sections 6 and 7): the ordered plan and the files the agent will
 * touch, each with a reason. Required before stage_edit; it feeds the plan view and the
 * Context Receipt. Paths are checked with the path guard; files that do not exist yet are fine.
 */
export const declareContext: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'declare_context',
    {
      title: 'Declare context',
      description:
        'Before staging any edit, declare your short ordered plan and every file you will change or create, each with a reason. You can call it again to add files.',
      inputSchema: {
        plan: z
          .array(z.string().min(1).max(300))
          .min(1)
          .max(15)
          .describe('Ordered steps, one short sentence each'),
        files: z
          .array(z.object({ path: z.string().min(1), reason: z.string().min(3).max(300) }))
          .min(1)
          .max(30)
          .describe('Files to change or create, with why each one is needed'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(
      ctx,
      'declare_context',
      async (args: { plan: string[]; files: { path: string; reason: string }[] }, call) => {
        const accepted: { path: string; reason: string; exists: boolean }[] = [];
        const rejected: string[] = [];
        for (const f of args.files) {
          const resolved = ctx.guard.resolve(f.path);
          if (!resolved.ok) {
            rejected.push(`${f.path}: ${resolved.code}. ${resolved.message}`);
            continue;
          }
          accepted.push({
            path: resolved.relative,
            reason: f.reason.trim(),
            exists: ctx.index.get(resolved.relative) !== undefined,
          });
        }
        if (rejected.length > 0) {
          throw new ToolError(
            'invalid_paths',
            `Nothing was declared. Fix these paths and declare again:\n${rejected.map((r) => `- ${r}`).join('\n')}`,
          );
        }
        const r = call.task.changeSet.declareContext({
          plan: args.plan,
          files: accepted.map(({ path, reason }) => ({ path, reason })),
        });
        if (!r.ok) throw new ToolError(r.error.code, r.error.message);
        const declared = call.task.changeSet.declaredContext;
        ctx.events.onDeclare?.(call.task.id, declared.plan, declared.files);
        const lines = [
          `Context declared: ${declared.files.length} file(s). You can now stage edits to these files with stage_edit.`,
          'Plan:',
          ...declared.plan.map((step, i) => `${i + 1}. ${step}`),
          'Files:',
          ...accepted.map((f) => `- ${f.path} (${f.exists ? 'existing' : 'new'}): ${f.reason}`),
        ];
        return textResult(lines.join('\n'));
      },
    ),
  );
};
