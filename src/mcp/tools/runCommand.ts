import { parse } from 'shell-quote';
import { z } from 'zod';
import { classifyCommand } from '../../safety/commandPolicy';
import { runTool, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, runInShadow } from './exec';

/**
 * run_command (blueprint sections 6 and 8): every command goes through the command policy.
 * Denied commands never run, even with approval. Allowlisted tests run as in run_tests.
 * Anything else needs the user's approval for this exact command (TrueForge pauses run_command
 * by name and the extension records the decision); approved commands still run without a shell
 * in a shadow copy, and the changes they make are reported, never applied or assumed reversible.
 */

/** Plain argv with leading VAR=value assignments moved into the environment; undefined if it needs a shell. */
function toArgv(command: string): { argv: string[]; env: Record<string, string> } | undefined {
  const entries = parse(command);
  if (entries.some((e) => typeof e !== 'string') || /[`$\n]/.test(command)) return undefined;
  const words = entries as string[];
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < words.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(words[i] ?? '');
    if (!m) break;
    env[m[1] ?? ''] = m[2] ?? '';
  }
  const argv = words.slice(i);
  return argv.length === 0 ? undefined : { argv, env };
}

export const runCommand: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description:
        'Run any other command. The user must approve it, and it runs in a temporary copy of the workspace with your staged edits, without a shell. Files it changes are reported but never applied. Destructive commands (rm -rf, sudo, git push, piping to a shell) are always refused.',
      inputSchema: {
        command: z.string().min(1).max(1000).describe('The exact command, without shell operators'),
        reason: z
          .string()
          .min(3)
          .max(300)
          .describe('Why you need it; shown to the user with the approval request'),
        timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_S).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    runTool(
      ctx,
      'run_command',
      async (
        args: { command: string; reason: string; timeout_seconds?: number | undefined },
        call,
      ) => {
        const command = args.command.trim();
        const decision = classifyCommand(command);
        const timeoutS = args.timeout_seconds ?? DEFAULT_TIMEOUT_S;

        if (decision.decision === 'deny') {
          ctx.events.onCommand?.(call.task.id, command, 'denied');
          throw new ToolError(
            decision.code,
            `${decision.reason} This command will not run, even with approval.`,
          );
        }
        if (decision.decision === 'run_test') {
          ctx.events.onCommand?.(call.task.id, command, 'test');
          return runInShadow(ctx, call, command, decision.argv, {
            runner: decision.runner,
            timeoutS,
          });
        }
        if (!ctx.approvals.consume(call.task.id, command)) {
          ctx.events.onCommand?.(call.task.id, command, 'approval_required');
          throw new ToolError(
            'approval_required',
            `The user has not approved this exact command: ${command}. Ask for it only if it is necessary; otherwise continue without it.`,
            { reason: args.reason },
          );
        }
        const parsed = toArgv(command);
        if (!parsed) {
          throw new ToolError(
            'needs_shell',
            'Commands run without a shell, so pipes, redirects, chains, globs and $variables are not supported. Run one plain command at a time.',
          );
        }
        ctx.events.onCommand?.(call.task.id, command, 'approved');
        return runInShadow(ctx, call, command, parsed.argv, { timeoutS, env: parsed.env });
      },
    ),
  );
};
