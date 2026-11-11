import manifest from '../../package.json';
import { estimateTokens } from './tokens';

/**
 * Token budgets (blueprint section 7). The shape and defaults come from the
 * `swage.budgets` setting in package.json, so the setting and the code cannot drift.
 */

export interface Budgets {
  /** Repository map size. */
  readonly repoMapTokens: number;
  /** Files in the hints block. */
  readonly hintsFiles: number;
  /** Hints block size. */
  readonly hintsTokens: number;
  /** One tool result before truncation. */
  readonly toolResultTokens: number;
  /** Full-file reads per run. */
  readonly readsPerRunTokens: number;
}

export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  ...manifest.contributes.configuration.properties['swage.budgets'].default,
});

const KEYS = Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[];

/** Merges a user `swage.budgets` value over the defaults, ignoring invalid entries. */
export function resolveBudgets(setting: unknown): Budgets {
  const out: Record<keyof Budgets, number> = { ...DEFAULT_BUDGETS };
  if (setting !== null && typeof setting === 'object') {
    for (const key of KEYS) {
      const value = (setting as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
    }
  }
  return out;
}

export const TRUNCATION_PREFIX = '[truncated:';

export interface Truncated {
  readonly text: string;
  readonly truncated: boolean;
  /** Estimated tokens of the returned text, marker included. */
  readonly tokens: number;
  readonly originalTokens: number;
}

/**
 * Cuts text to about `maxTokens`, on a line boundary when possible, and appends a marker
 * telling the agent what it did not see and how to ask for more.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  howToGetMore = 'request a line range (startLine and endLine) or narrow the query',
): Truncated {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) {
    return { text, truncated: false, tokens: originalTokens, originalTokens };
  }
  const totalLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const build = (maxChars: number): string => {
    let cut = text.slice(0, Math.max(0, maxChars));
    const lastNewline = cut.lastIndexOf('\n');
    if (lastNewline > maxChars / 2) cut = cut.slice(0, lastNewline + 1);
    const shownLines = cut === '' ? 0 : cut.split('\n').length - (cut.endsWith('\n') ? 1 : 0);
    const range =
      shownLines > 0 ? `lines 1-${shownLines} of ${totalLines}` : `0 of ${totalLines} lines`;
    const marker = `${TRUNCATION_PREFIX} showing about ${estimateTokens(cut)} of ${originalTokens} tokens (${range}). To see more, ${howToGetMore}.]`;
    return `${cut}${cut.endsWith('\n') || cut === '' ? '' : '\n'}${marker}`;
  };
  // Reserve room for the marker so the result stays within the budget.
  let maxChars = maxTokens * 4 - build(0).length - 1;
  let out = build(maxChars);
  for (let i = 0; i < 3 && estimateTokens(out) > maxTokens && maxChars > 0; i++) {
    maxChars -= (estimateTokens(out) - maxTokens) * 4 + 4;
    out = build(maxChars);
  }
  return { text: out, truncated: true, tokens: estimateTokens(out), originalTokens };
}

export type ReadDecision =
  | { readonly ok: true; readonly used: number; readonly remaining: number }
  | {
      readonly ok: false;
      readonly used: number;
      readonly remaining: number;
      readonly message: string;
    };

/**
 * Tracks file-read tokens for one run. Once the budget is spent, full-file reads are
 * refused and only ranged reads are allowed (blueprint section 7).
 */
export class ReadBudget {
  private usedTokens = 0;

  constructor(readonly limit: number = DEFAULT_BUDGETS.readsPerRunTokens) {}

  get used(): number {
    return this.usedTokens;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedTokens);
  }

  /** Records a read of `tokens`. A full read that would exceed the budget is refused. */
  charge(path: string, tokens: number, options: { ranged?: boolean } = {}): ReadDecision {
    if (options.ranged !== true && this.usedTokens + tokens > this.limit) {
      return {
        ok: false,
        used: this.usedTokens,
        remaining: this.remaining,
        message: `Read budget reached: ${this.usedTokens} of ${this.limit} tokens used this run, and ${path} needs about ${tokens}. Read a line range instead (startLine and endLine), or use find_relevant_code to locate the exact lines.`,
      };
    }
    this.usedTokens += tokens;
    return { ok: true, used: this.usedTokens, remaining: this.remaining };
  }

  reset(): void {
    this.usedTokens = 0;
  }
}
