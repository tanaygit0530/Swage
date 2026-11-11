import { z } from 'zod';
import { buildRepoMap } from '../../context/repoMap';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import type { ToolRegistration } from '../server';

export const repoMap: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'repo_map',
    {
      title: 'Repository map',
      description:
        'A ranked outline of the repository: files and their top-level symbols, most central first, within a small token budget. Use path_prefix to zoom into a folder.',
      inputSchema: {
        path_prefix: z
          .string()
          .optional()
          .describe('Only map files under this folder, for example src/flask/'),
        max_tokens: z
          .number()
          .int()
          .min(200)
          .max(4000)
          .optional()
          .describe('Budget for the map; default 1,500'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(
      ctx,
      'repo_map',
      async (args: { path_prefix?: string | undefined; max_tokens?: number | undefined }) => {
        const prefix = args.path_prefix?.replace(/^\.\//, '') ?? '';
        const map = buildRepoMap(ctx.index, {
          maxTokens: Math.min(
            args.max_tokens ?? ctx.budgets.repoMapTokens,
            ctx.budgets.toolResultTokens,
          ),
          pathPrefix: prefix,
        });
        if (map.files.length === 0 && map.omitted === 0) {
          throw new ToolError(
            'no_files',
            `No indexed files under "${prefix}". Call repo_map without path_prefix to see the top-level folders.`,
          );
        }
        return textResult(map.text);
      },
    ),
  );
};
