import { z } from 'zod';
import { classifyCommand } from '../../safety/commandPolicy';
import { runTool, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, runInShadow } from './exec';

/**
 * run_tests (blueprint section 6): an allowlisted test command, run without a shell in a
 * temporary shadow copy of the workspace overlaid with the staged edits. Anything else is
 * refused with the policy's reason; other commands go through run_command and need approval.
 */
export const runTests: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'run_tests',
    {
      title: 'Run tests',
      description:
        'Run an allowlisted test command (pytest, python -m pytest, npm test, vitest, jest, go test, cargo test) against your staged edits, in a temporary copy of the workspace. No shell: plain arguments only. Never changes the workspace.',
      inputSchema: {
        command: z.string().min(1).max(1000).describe('For example: pytest tests/test_cli.py -q'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_S)
          .optional()
          .describe(`Default ${DEFAULT_TIMEOUT_S}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(
      ctx,
      'run_tests',
      async (args: { command: string; timeout_seconds?: number | undefined }, call) => {
        const decision = classifyCommand(args.command);
        if (decision.decision === 'deny') throw new ToolError(decision.code, decision.reason);
        if (decision.decision === 'ask') {
          throw new ToolError(
            'not_a_test_command',
            `${decision.reason} run_tests only runs allowlisted test commands; use run_command for anything else.`,
          );
        }
        return runInShadow(ctx, call, args.command, decision.argv, {
          runner: decision.runner,
          timeoutS: args.timeout_seconds ?? DEFAULT_TIMEOUT_S,
        });
      },
    ),
  );
};
