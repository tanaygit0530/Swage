import { redact } from '../safety/redact';
import { DEFAULT_BUDGETS, truncateToTokens, type Budgets } from './budget';
import type { WorkspaceIndex } from './indexer';
import type { CodeSymbol } from './symbols';
import { estimateTokens } from './tokens';

/**
 * Explicit `@file` and `@symbol` mentions (blueprint section 7, step 2). The user's
 * choices are always attached, within a cap, and the report says exactly what was
 * attached and what it cost.
 */

export type MentionKind = 'file' | 'symbol';

export interface Mention {
  /** Text as typed, including `@`. */
  readonly raw: string;
  /** `file` or `symbol` when the user wrote `@file:` or `@symbol:`, otherwise a guess. */
  readonly kind: MentionKind;
  readonly explicit: boolean;
  readonly target: string;
  readonly start: number;
  readonly end: number;
}

const MENTION = /(^|[\s(["'`])@((?:file|symbol):)?([A-Za-z0-9_$][\w$./\\-]*)/g;

/** Finds mentions; `@` inside a word (an email address) is not a mention. */
export function parseMentions(prompt: string): Mention[] {
  const out: Mention[] = [];
  for (const m of prompt.matchAll(MENTION)) {
    const [, lead = '', prefix, rawTarget = ''] = m;
    const target = rawTarget.replace(/[.,;:!?)\]'"`]+$/, '');
    if (target === '') continue;
    const start = (m.index ?? 0) + lead.length;
    const raw = `@${prefix ?? ''}${target}`;
    const explicitKind = prefix === 'file:' ? 'file' : prefix === 'symbol:' ? 'symbol' : undefined;
    const looksLikeFile = /[/\\]/.test(target) || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(target);
    out.push({
      raw,
      kind: explicitKind ?? (looksLikeFile ? 'file' : 'symbol'),
      explicit: explicitKind !== undefined,
      target: target.replace(/\\/g, '/'),
      start,
      end: start + raw.length,
    });
  }
  return out;
}

export interface Completion {
  readonly kind: MentionKind;
  /** What to show in the list. */
  readonly label: string;
  /** Where it lives, for example `src/flask/cli.py:42`. */
  readonly detail: string;
  /** Text to insert, including `@`. */
  readonly insertText: string;
  readonly score: number;
}

/** Subsequence fuzzy score: higher for consecutive runs, segment starts and short candidates. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (q === '') return 1;
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      run++;
      score += 1 + run;
      const prev = ci === 0 ? '/' : c[ci - 1];
      if (prev === '/' || prev === '_' || prev === '.' || prev === '-' || candidate[ci] !== c[ci])
        score += 3;
      qi++;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return 0;
  if (c.endsWith(q)) score += 5;
  return score / (1 + c.length / 40);
}

/** Completion data for the editor: files and symbols matching what follows `@`. */
export function mentionCompletions(
  index: WorkspaceIndex,
  partial: string,
  limit = 10,
): Completion[] {
  const query = partial.replace(/^@/, '').replace(/^(file|symbol):/, '');
  const out: Completion[] = [];
  for (const rec of index.files()) {
    const score = fuzzyScore(query, rec.path);
    if (score > 0) {
      out.push({
        kind: 'file',
        label: rec.path,
        detail: rec.language,
        insertText: `@${rec.path}`,
        score,
      });
    }
    for (const s of rec.symbols) {
      const name = s.container === undefined ? s.name : `${s.container}.${s.name}`;
      const sScore = fuzzyScore(query, name);
      if (sScore > 0) {
        out.push({
          kind: 'symbol',
          label: name,
          detail: `${s.kind} in ${rec.path}:${s.line}`,
          insertText: `@${name}`,
          // Prefer symbols slightly: they are the more specific choice.
          score: sScore * 1.1,
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : 1)).slice(0, limit);
}

export interface Attachment {
  readonly mention: string;
  readonly kind: MentionKind;
  readonly path: string;
  readonly symbol?: string;
  /** 1-based inclusive line range of the attached content. */
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly tokens: number;
  readonly truncated: boolean;
  readonly redactions: number;
  /** Where a mentioned symbol is used, for `@symbol` (definition plus immediate callers). */
  readonly callers: readonly { readonly path: string; readonly line: number }[];
  readonly reason: string;
}

export interface UnresolvedMention {
  readonly mention: string;
  readonly message: string;
  readonly suggestions: readonly string[];
}

export interface MentionResult {
  readonly attachments: readonly Attachment[];
  readonly unresolved: readonly UnresolvedMention[];
  readonly totalTokens: number;
  readonly budgetTokens: number;
  /** One line per mention, ready for the Context Receipt. */
  readonly report: string;
}

export interface ResolveOptions {
  readonly budgets?: Budgets;
  /** Total cap for all attachments; defaults to two tool results (8,000 tokens). */
  readonly maxTotalTokens?: number;
  readonly maxCallers?: number;
}

/** Below this many remaining tokens, a mention is reported instead of attached as a fragment. */
export const MIN_ATTACHMENT_TOKENS = 100;

function resolveFile(
  index: WorkspaceIndex,
  target: string,
): { path?: string; suggestions: string[] } {
  const clean = target.replace(/^\.\//, '');
  if (index.get(clean)) return { path: clean, suggestions: [] };
  const suffix = index.files().filter((f) => f.path === clean || f.path.endsWith(`/${clean}`));
  if (suffix.length === 1 && suffix[0]) return { path: suffix[0].path, suggestions: [] };
  if (suffix.length > 1) return { suggestions: suffix.map((f) => f.path).slice(0, 5) };
  return {
    suggestions: mentionCompletions(index, clean, 5)
      .filter((c) => c.kind === 'file')
      .map((c) => c.label),
  };
}

function findSymbols(
  index: WorkspaceIndex,
  target: string,
): { path: string; symbol: CodeSymbol }[] {
  const [container, name] = target.includes('.')
    ? (target.split('.', 2) as [string, string])
    : [undefined, target];
  const out: { path: string; symbol: CodeSymbol }[] = [];
  for (const rec of index.files()) {
    for (const s of rec.symbols) {
      if (s.name === name && (container === undefined || s.container === container))
        out.push({ path: rec.path, symbol: s });
    }
  }
  // Top-level definitions before methods with the same name.
  return out.sort(
    (a, b) => Number(a.symbol.container !== undefined) - Number(b.symbol.container !== undefined),
  );
}

async function findCallers(
  index: WorkspaceIndex,
  name: string,
  def: { path: string; symbol: CodeSymbol },
  max: number,
): Promise<{ path: string; line: number }[]> {
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  const out: { path: string; line: number }[] = [];
  for (const rec of index.files()) {
    if (out.length >= max) break;
    if (!rec.symbols.length && !/\.(py|[cm]?[jt]sx?)$/.test(rec.path)) continue;
    const text = await index.readText(rec.path);
    if (text === undefined || !word.test(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = i + 1;
      const inDef = rec.path === def.path && line >= def.symbol.line && line <= def.symbol.endLine;
      if (!inDef && word.test(lines[i] ?? '')) out.push({ path: rec.path, line });
    }
  }
  return out;
}

/** Resolves every mention in a prompt to redacted, budgeted content. */
export async function resolveMentions(
  prompt: string,
  index: WorkspaceIndex,
  options: ResolveOptions = {},
): Promise<MentionResult> {
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const maxTotal = options.maxTotalTokens ?? budgets.toolResultTokens * 2;
  const maxCallers = options.maxCallers ?? 10;
  const attachments: Attachment[] = [];
  const unresolved: UnresolvedMention[] = [];
  const seen = new Set<string>();
  let total = 0;

  const attach = (
    a: Omit<Attachment, 'tokens' | 'truncated' | 'redactions' | 'content'>,
    raw: string,
  ): void => {
    const remaining = Math.max(0, maxTotal - total);
    const cap = Math.min(budgets.toolResultTokens, remaining);
    // A few leftover tokens would only attach a useless fragment.
    if (cap < MIN_ATTACHMENT_TOKENS) {
      unresolved.push({
        mention: a.mention,
        message: `Not attached: the mention budget of ${maxTotal} tokens is used up. The agent can still read ${a.path}.`,
        suggestions: [],
      });
      return;
    }
    const red = redact(raw);
    const cut = truncateToTokens(red.text, cap, `read ${a.path} with a line range`);
    total += cut.tokens;
    attachments.push({
      ...a,
      content: cut.text,
      tokens: cut.tokens,
      truncated: cut.truncated,
      redactions: red.count,
    });
  };

  for (const m of parseMentions(prompt)) {
    const tryFile = async (): Promise<boolean> => {
      const { path } = resolveFile(index, m.target);
      if (path === undefined) return false;
      if (seen.has(path)) return true;
      seen.add(path);
      const text = (await index.readText(path)) ?? '';
      const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      attach(
        {
          mention: m.raw,
          kind: 'file',
          path,
          startLine: 1,
          endLine: Math.max(1, lineCount),
          callers: [],
          reason: 'mentioned by user',
        },
        text,
      );
      return true;
    };
    const trySymbol = async (): Promise<boolean> => {
      const defs = findSymbols(index, m.target);
      const def = defs[0];
      if (!def) return false;
      const key = `${def.path}#${def.symbol.name}@${def.symbol.line}`;
      if (seen.has(key)) return true;
      seen.add(key);
      const text = (await index.readText(def.path)) ?? '';
      const body =
        text
          .split('\n')
          .slice(def.symbol.line - 1, def.symbol.endLine)
          .join('\n') + '\n';
      const callers = await findCallers(index, def.symbol.name, def, maxCallers);
      attach(
        {
          mention: m.raw,
          kind: 'symbol',
          path: def.path,
          symbol:
            def.symbol.container === undefined
              ? def.symbol.name
              : `${def.symbol.container}.${def.symbol.name}`,
          startLine: def.symbol.line,
          endLine: def.symbol.endLine,
          callers,
          reason:
            defs.length > 1
              ? `mentioned by user (${defs.length} definitions; using the first)`
              : 'mentioned by user',
        },
        body,
      );
      return true;
    };

    const order = m.kind === 'file' ? [tryFile, trySymbol] : [trySymbol, tryFile];
    let done = false;
    for (const attempt of m.explicit ? order.slice(0, 1) : order) {
      if (await attempt()) {
        done = true;
        break;
      }
    }
    if (!done) {
      const suggestions = mentionCompletions(index, m.target, 5).map((c) => c.insertText);
      const ambiguous = resolveFile(index, m.target).suggestions;
      unresolved.push({
        mention: m.raw,
        message:
          ambiguous.length > 1 &&
          index.files().filter((f) => f.path.endsWith(`/${m.target}`)).length > 1
            ? `${m.raw} matches several files; give more of the path.`
            : `${m.raw} does not match a file or symbol in the workspace.`,
        suggestions: ambiguous.length > 1 ? ambiguous.map((p) => `@${p}`) : suggestions,
      });
    }
  }

  const report = [
    ...attachments.map((a) => {
      const what =
        a.kind === 'symbol' ? `${a.symbol ?? ''} in ${a.path}:${a.startLine}-${a.endLine}` : a.path;
      const extras = [
        a.truncated ? 'truncated' : '',
        a.redactions > 0 ? `${a.redactions} secret(s) redacted` : '',
        a.callers.length > 0 ? `${a.callers.length} caller(s) listed` : '',
      ].filter(Boolean);
      return `Attached ${a.mention}: ${what} (${a.tokens.toLocaleString('en-US')} tokens${extras.length ? `; ${extras.join('; ')}` : ''})`;
    }),
    ...unresolved.map(
      (u) =>
        `Not attached ${u.mention}: ${u.message}${u.suggestions.length ? ` Did you mean ${u.suggestions.join(', ')}?` : ''}`,
    ),
    `Mentions total: ${total.toLocaleString('en-US')} of ${maxTotal.toLocaleString('en-US')} tokens`,
  ].join('\n');

  return { attachments, unresolved, totalTokens: total, budgetTokens: maxTotal, report };
}

/** Estimated cost of a prompt with its attachments, for the Receipt's budget bar. */
export function promptCost(prompt: string, result: MentionResult): number {
  return estimateTokens(prompt) + result.totalTokens;
}
