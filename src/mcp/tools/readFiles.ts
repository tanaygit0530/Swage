import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { MAX_FILE_BYTES } from '../../context/indexer';
import { fuzzyScore } from '../../context/mentions';
import { estimateTokens } from '../../context/tokens';
import { errorResult, runTool, textResult, type ToolCall, type ToolContext } from '../context';
import { capResult, DATA_NOTE, fileBlock, sliceLines } from '../format';
import type { ToolRegistration } from '../server';

/**
 * read_files (blueprint section 6): batched, line-ranged reads with a content hash per file.
 * Paths go through the path guard, content is redacted, the result is capped at the per-result
 * budget, and full-file reads count against the per-run read budget. Reads see the staged
 * overlay, so the agent reads its own staged edits; the disk is never written.
 */

const FileRequest = z.object({
  path: z.string().min(1).describe('Workspace-relative path'),
  start_line: z.number().int().min(1).optional().describe('First line, 1-based'),
  end_line: z.number().int().min(1).optional().describe('Last line, inclusive'),
});

type FileArgs = z.infer<typeof FileRequest>;

function suggest(ctx: ToolContext, wanted: string): string[] {
  const base = wanted.split('/').pop() ?? wanted;
  return ctx.index
    .files()
    .map((f) => ({
      path: f.path,
      score: fuzzyScore(base, f.path) + (f.path.endsWith(`/${base}`) ? 10 : 0),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.path);
}

async function readOne(
  ctx: ToolContext,
  call: ToolCall,
  req: FileArgs,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const resolved = ctx.guard.resolve(req.path);
  if (!resolved.ok)
    return { ok: false, text: `${req.path}: ${resolved.code}. ${resolved.message}` };
  const rel = resolved.relative;

  const staged = call.task.changeSet.staged(rel);
  let content: string;
  let note = '';
  let hashSource: string | undefined;
  if (staged) {
    if (staged.deleted) return { ok: false, text: `${rel}: deleted in the staged change set.` };
    content = staged.content;
    note = '(staged view, not yet on disk)';
  } else {
    const stat = await fsp.stat(resolved.absolute).catch(() => undefined);
    if (!stat?.isFile()) {
      const near = suggest(ctx, rel);
      return {
        ok: false,
        text: `${rel}: file not found.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}`,
      };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        text: `${rel}: too large to read (${stat.size} bytes). Use find_relevant_code to locate the lines, then read a range.`,
      };
    }
    const bytes = await fsp.readFile(resolved.absolute);
    if (bytes.subarray(0, 8000).includes(0))
      return { ok: false, text: `${rel}: binary file; not readable as text.` };
    content = bytes.toString('utf8');
    hashSource = content;
  }

  const ranged = req.start_line !== undefined || req.end_line !== undefined;
  const slice = sliceLines(content, req.start_line ?? 1, req.end_line ?? Number.MAX_SAFE_INTEGER);
  const decision = call.task.readBudget.charge(rel, estimateTokens(slice.content), { ranged });
  if (!decision.ok) return { ok: false, text: `${rel}: ${decision.message}` };
  const hash =
    hashSource === undefined
      ? ''
      : ` sha256 ${createHash('sha256').update(hashSource).digest('hex').slice(0, 12)}`;
  return {
    ok: true,
    text: fileBlock(
      rel,
      slice.start,
      slice.end,
      slice.total,
      slice.content,
      `${note}${hash}`.trim(),
    ),
  };
}

export const readFiles: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'read_files',
    {
      title: 'Read files',
      description:
        'Read up to 10 workspace files in one call, optionally a line range of each. Shows staged edits when a file is staged. Full reads count against a per-run budget; prefer ranges for large files.',
      inputSchema: { files: z.array(FileRequest).min(1).max(10) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(ctx, 'read_files', async (args: { files: FileArgs[] }, call) => {
      const blocks: string[] = [];
      const problems: string[] = [];
      for (const req of args.files) {
        call.signal.throwIfAborted();
        const r = await readOne(ctx, call, req);
        (r.ok ? blocks : problems).push(r.text);
      }
      if (blocks.length === 0) {
        return errorResult('read_failed', problems.join('\n'));
      }
      const budget = call.task.readBudget;
      const footer = [
        ...(problems.length ? [`Not read:\n${problems.map((p) => `- ${p}`).join('\n')}`] : []),
        `Read budget: ${budget.used} of ${budget.limit} tokens used this run.`,
      ].join('\n');
      return textResult(
        capResult(
          `${DATA_NOTE}\n${blocks.join('\n')}\n${footer}`,
          ctx.budgets.toolResultTokens,
          'read fewer files, or a line range (start_line and end_line)',
        ),
      );
    }),
  );
};
