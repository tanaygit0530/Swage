import { z } from 'zod';
import { tokenize } from '../../context/tokens';
import { runTool, textResult, ToolError, type ToolContext } from '../context';
import { capResult, DATA_NOTE, fileBlock, sliceLines } from '../format';
import type { ToolRegistration } from '../server';

/** Lines shown around the best match when a file has no matching symbol. */
const CONTEXT_LINES = 8;
/** Longest snippet taken from a matching symbol. */
const MAX_SYMBOL_LINES = 40;

function bestLine(text: string, query: string): number {
  const terms = new Set(tokenize(query));
  let best = 1;
  let bestScore = -1;
  text.split('\n').forEach((line, i) => {
    const score = tokenize(line).filter((t) => terms.has(t)).length;
    if (score > bestScore) {
      best = i + 1;
      bestScore = score;
    }
  });
  return best;
}

/**
 * The lines to show for a search hit: its best matching symbol (up to 40 lines), or 8 lines
 * either side of the line that matches the query best. Shared with the first message's excerpts.
 */
export function snippetRange(
  text: string,
  hit: { lines?: { start: number; end: number } | undefined },
  query: string,
): { start: number; end: number } {
  if (hit.lines)
    return {
      start: hit.lines.start,
      end: Math.min(hit.lines.end, hit.lines.start + MAX_SYMBOL_LINES - 1),
    };
  const at = bestLine(text, query);
  return { start: at - CONTEXT_LINES, end: at + CONTEXT_LINES };
}

export const findRelevantCode: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'find_relevant_code',
    {
      title: 'Find relevant code',
      description:
        'Search the workspace for code relevant to a task. Returns ranked files with the reason each was chosen and a snippet. Lexical and fast; use specific identifiers and domain words.',
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(2000)
          .describe('What you are looking for, in plain words or identifiers'),
        limit: z.number().int().min(1).max(10).optional().describe('Number of files, default 5'),
        path_prefix: z
          .string()
          .optional()
          .describe('Only return files under this folder, for example src/flask/'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(
      ctx,
      'find_relevant_code',
      async (args: {
        query: string;
        limit?: number | undefined;
        path_prefix?: string | undefined;
      }) => {
        const limit = args.limit ?? 5;
        const prefix = args.path_prefix?.replace(/^\.\//, '') ?? '';
        const hits = ctx.searcher
          .search(args.query, { limit: prefix === '' ? limit : 50 })
          .filter((h) => h.path.startsWith(prefix))
          .slice(0, limit);
        if (hits.length === 0) {
          throw new ToolError(
            'no_results',
            `Nothing matched "${args.query}"${prefix ? ` under ${prefix}` : ''}. Try other words, an identifier, or repo_map to browse.`,
          );
        }
        const parts = [`${hits.length} result(s) for "${args.query}". ${DATA_NOTE}`];
        for (const [i, hit] of hits.entries()) {
          const text = (await ctx.readText(hit.path)) ?? '';
          const range = snippetRange(text, hit, args.query);
          const s = sliceLines(text, range.start, range.end);
          parts.push(
            `${i + 1}. ${hit.path} (score ${hit.score}; about ${hit.estimatedTokens} tokens to read whole)\n   why: ${hit.reasons.join('; ') || 'lexical match'}\n${fileBlock(hit.path, s.start, s.end, s.total, s.content)}`,
          );
        }
        return textResult(
          capResult(
            parts.join('\n\n'),
            ctx.budgets.toolResultTokens,
            'lower limit, add path_prefix, or read one file with read_files',
          ),
        );
      },
    ),
  );
};
