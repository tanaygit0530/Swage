import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, textResult, type ToolCall, type ToolContext } from '../context';
import { capResult } from '../format';
import {
  createShadow,
  describeChanges,
  diffSnapshots,
  prepareCommand,
  runProcess,
  snapshot,
} from '../shadow';

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;

/**
 * Runs an already-approved argv in a fresh shadow copy with the staged overlay, then reports
 * the exit status, the files the command changed in the copy, and the output tail. The copy
 * is deleted afterwards; nothing it changed is applied to the workspace.
 */
export async function runInShadow(
  ctx: ToolContext,
  call: ToolCall,
  command: string,
  argv: readonly string[],
  options: { runner?: string; timeoutS: number; env?: Record<string, string> },
): Promise<CallToolResult> {
  const t0 = performance.now();
  const shadow = await createShadow(ctx.root, ctx.guard, call.task.changeSet);
  const tCopy = performance.now();
  try {
    call.signal.throwIfAborted();
    const before = await snapshot(shadow.dir);
    const prepared = prepareCommand(argv, ctx.root, shadow.dir, options.runner);
    const run = await runProcess(prepared.argv, {
      cwd: shadow.dir,
      env: { ...prepared.env, ...(options.env ?? {}) },
      timeoutMs: options.timeoutS * 1000,
      signal: call.signal,
    });
    call.signal.throwIfAborted();
    const changes = diffSnapshots(before, await snapshot(shadow.dir));
    ctx.logger.info(
      `shadow copy ${Math.round(tCopy - t0)} ms, command ${run.ms} ms, total ${Math.round(performance.now() - t0)} ms`,
    );

    const status = run.timedOut
      ? `Timed out after ${options.timeoutS} s; the process tree was killed.`
      : run.exitCode === null
        ? `Did not run or was killed (${run.signal ?? 'no exit code'}).`
        : `Exit code ${run.exitCode} in ${run.ms} ms.`;
    const header = [
      `Command: ${command}`,
      `Ran in a temporary copy of the workspace with ${shadow.overlaid.length} staged file(s) applied${shadow.overlaid.length ? ` (${shadow.overlaid.join(', ')})` : ''}. The workspace itself was not changed.`,
      status,
      'Files the command changed in the copy (discarded, not applied; do not assume they can be undone elsewhere):',
      describeChanges(changes),
      `Output${run.droppedBytes > 0 ? ` (last part; ${run.droppedBytes} earlier bytes dropped)` : ''}:`,
    ].join('\n');
    const body = capResult(
      `${header}\n${run.output.trimEnd() || '(no output)'}`,
      ctx.budgets.toolResultTokens,
      'run fewer tests, for example one test file',
    );
    if (run.timedOut || run.exitCode === null)
      return errorResult(run.timedOut ? 'timeout' : 'not_run', body);
    return textResult(body);
  } finally {
    await shadow.dispose();
  }
}
