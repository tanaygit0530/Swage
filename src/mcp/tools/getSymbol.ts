import * as path from 'node:path';
import { z } from 'zod';
import { testedStem } from '../../context/bm25';
import { resolveMentions } from '../../context/mentions';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import { capResult, DATA_NOTE, fileBlock } from '../format';
import type { ToolRegistration } from '../server';

/** Paired tests for a source file: tests named after its stem, such as tests/test_cli.py for cli.py. */
function pairedTests(ctx: ToolContext, sourcePath: string): string[] {
  const stem = path.posix.basename(sourcePath).replace(/\.[^.]+$/, '');
  return ctx.index
    .files()
    .map((f) => f.path)
    .filter((p) => p !== sourcePath && testedStem(p) === stem);
}

export const getSymbol: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'get_symbol',
    {
      title: 'Get symbol',
      description:
        'Definition of a function, class, method or constant, where it is used, and its paired test files. Accepts Name or Class.method.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(200)
          .regex(
            /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/,
            'Use an identifier such as get_debug_flag or ScriptInfo.load_app',
          )
          .describe('Symbol name, for example get_debug_flag or ScriptInfo.load_app'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(ctx, 'get_symbol', async (args: { name: string }) => {
      const result = await resolveMentions(`@symbol:${args.name}`, ctx.index, {
        budgets: ctx.budgets,
        maxTotalTokens: ctx.budgets.toolResultTokens,
        maxCallers: 15,
      });
      const def = result.attachments[0];
      if (!def) {
        const suggestions = result.unresolved[0]?.suggestions.map((s) => s.replace(/^@/, '')) ?? [];
        throw new ToolError(
          'symbol_not_found',
          `No definition of ${args.name} in the index.${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ''} Try find_relevant_code.`,
        );
      }
      const others = ctx.index
        .files()
        .flatMap((f) =>
          f.symbols
            .filter((s) => s.name === (args.name.split('.').pop() ?? args.name))
            .map((s) => `${f.path}:${s.line}`),
        )
        .filter((loc) => loc !== `${def.path}:${def.startLine}`);
      const tests = pairedTests(ctx, def.path);
      const lines = [
        `${def.symbol ?? args.name} is defined in ${def.path} lines ${def.startLine}-${def.endLine}. ${DATA_NOTE}`,
        fileBlock(def.path, def.startLine, def.endLine, def.endLine, def.content).replace(
          / of \d+>>>/,
          '>>>',
        ),
        def.callers.length
          ? `Used at (${def.callers.length}${def.callers.length >= 15 ? '+' : ''}):\n${def.callers.map((c) => `- ${c.path}:${c.line}`).join('\n')}`
          : 'No uses found outside the definition.',
        tests.length ? `Paired tests: ${tests.join(', ')}` : 'No paired test file found.',
        ...(others.length
          ? [`Other definitions with this name: ${others.slice(0, 5).join(', ')}`]
          : []),
      ];
      return textResult(
        capResult(
          lines.join('\n'),
          ctx.budgets.toolResultTokens,
          'read the definition with read_files and a line range',
        ),
      );
    }),
  );
};
