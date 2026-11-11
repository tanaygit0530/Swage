import {
  checkDeletedSymbols,
  type FileSnapshot,
  type SymbolWarning,
} from '../../changeset/symbols';
import type { ToolContext } from '../context';
import type { Task } from '../tasks';

/**
 * Deleted-symbol warnings for the staged change set. Besides the staged files themselves, it
 * checks unchanged files that import a staged file (from the context engine's import graph),
 * so a caller left behind is reported even if the agent never touched it.
 */
export async function symbolWarnings(ctx: ToolContext, task: Task): Promise<SymbolWarning[]> {
  const staged = task.changeSet.stagedPaths();
  const stagedSet = new Set(staged);
  const { reverse } = ctx.index.importGraph();
  const importers = new Set<string>();
  for (const p of staged)
    for (const i of reverse.get(p) ?? []) if (!stagedSet.has(i)) importers.add(i);

  const snapshots: FileSnapshot[] = await Promise.all([
    ...staged.map(async (p) => {
      const view = task.changeSet.staged(p);
      return {
        path: p,
        before: await ctx.readText(p),
        after: view?.deleted ? undefined : view?.content,
      };
    }),
    ...[...importers].map(async (p) => {
      const text = await ctx.readText(p);
      return { path: p, before: text, after: text };
    }),
  ]);
  return checkDeletedSymbols(snapshots);
}
