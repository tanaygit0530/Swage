import { DEFAULT_BUDGETS } from './budget';
import type { FileRecord, WorkspaceIndex } from './indexer';
import type { CodeSymbol, CodeSymbolKind } from './symbols';
import { estimateTokens } from './tokens';

/**
 * Repository map (blueprint section 7): a ranked outline of files and their top symbols,
 * capped near the repo-map budget, so the agent sees the shape of the repository before
 * it searches. Lowest-ranked files are dropped first.
 */

export interface RepoMapOptions {
  /** Token cap; defaults to the `repoMapTokens` budget (1,500). */
  readonly maxTokens?: number;
  /** Extra ranking, for example search scores for the current task. Higher comes first. */
  readonly rank?: ReadonlyMap<string, number>;
  /** Only include paths that start with this prefix. */
  readonly pathPrefix?: string;
  readonly maxSymbolsPerFile?: number;
}

export interface RepoMap {
  readonly text: string;
  readonly tokens: number;
  /** Included files, in output order. */
  readonly files: readonly string[];
  readonly omitted: number;
}

const KIND_ORDER: Record<CodeSymbolKind, number> = {
  class: 0,
  function: 1,
  interface: 2,
  type: 3,
  enum: 4,
  export: 5,
  constant: 6,
  method: 7,
};

function isTest(p: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(p) || /(^|\/)test_[^/]+$|\.(test|spec)\.[^/]+$/.test(p);
}

function topSymbols(symbols: readonly CodeSymbol[], max: number): string {
  const top = symbols
    .filter((s) => s.container === undefined && !s.name.startsWith('_'))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.line - b.line);
  const names = top.slice(0, max).map((s) => s.name);
  const more = top.length - names.length;
  return more > 0 ? `${names.join(', ')}, +${more}` : names.join(', ');
}

/** Default importance: imported by many files, many symbols, source before tests. */
function centrality(rec: FileRecord, importers: number): number {
  return (
    importers * 2 +
    Math.min(rec.symbols.length, 20) * 0.1 +
    (isTest(rec.path) ? -1 : 0) +
    (rec.symbols.length > 0 ? 1 : 0)
  );
}

export function buildRepoMap(index: WorkspaceIndex, options: RepoMapOptions = {}): RepoMap {
  const maxTokens = options.maxTokens ?? DEFAULT_BUDGETS.repoMapTokens;
  const maxSymbols = options.maxSymbolsPerFile ?? 6;
  const prefix = options.pathPrefix ?? '';
  const { reverse } = index.importGraph();

  const records = index.files().filter((f) => f.path.startsWith(prefix));
  const scored = records.map((rec) => ({
    rec,
    score:
      (options.rank?.get(rec.path) ?? 0) * 100 + centrality(rec, reverse.get(rec.path)?.size ?? 0),
  }));
  scored.sort((a, b) => b.score - a.score || (a.rec.path < b.rec.path ? -1 : 1));

  const header = `Repository map${prefix === '' ? '' : ` of ${prefix}`} (${records.length} files, most relevant first; symbols are top-level definitions):`;
  const lines: string[] = [header];
  const files: string[] = [];
  let used = estimateTokens(header) + 1;
  // Leave room for the omitted-files footer.
  const reserve = 40;

  for (const { rec } of scored) {
    const symbols = topSymbols(rec.symbols, maxSymbols);
    const line = symbols === '' ? rec.path : `${rec.path}: ${symbols}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens - reserve) continue;
    lines.push(line);
    files.push(rec.path);
    used += cost;
  }

  const omitted = records.length - files.length;
  if (omitted > 0) {
    lines.push(
      `... ${omitted} more files omitted. Call repo_map with a path prefix, or find_relevant_code, to see them.`,
    );
  }
  const text = lines.join('\n');
  return { text, tokens: estimateTokens(text), files, omitted };
}
