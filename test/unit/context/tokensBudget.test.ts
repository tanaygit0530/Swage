import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGETS,
  ReadBudget,
  resolveBudgets,
  TRUNCATION_PREFIX,
  truncateToTokens,
} from '../../../src/context/budget';
import {
  estimateTokens,
  splitIdentifier,
  stem,
  termFrequencies,
  tokenize,
} from '../../../src/context/tokens';

describe('tokens', () => {
  it('splits snake_case, camelCase, PascalCase, acronyms and paths', () => {
    expect(splitIdentifier('get_debug_flag')).toEqual(['get', 'debug', 'flag']);
    expect(splitIdentifier('getDebugFlag')).toEqual(['get', 'debug', 'flag']);
    expect(splitIdentifier('HTTPServerError')).toEqual(['http', 'server', 'error']);
    expect(splitIdentifier('parse2Json')).toEqual(['parse2', 'json']);
    expect(splitIdentifier('src/flask/cli.py')).toEqual(['src', 'flask', 'cli', 'py']);
    expect(splitIdentifier('__init__')).toEqual(['init']);
  });

  it('stems plurals and common suffixes consistently', () => {
    expect(stem('routes')).toBe(stem('route'));
    expect(stem('masking')).toBe(stem('mask'));
    expect(stem('loaded')).toBe(stem('load'));
    expect(stem('entries')).toBe('entry');
    expect(stem('class')).toBe('class');
    expect(stem('status')).toBe('status');
    expect(stem('cli')).toBe('cli');
  });

  it('tokenizes code and prose, dropping stop words, keywords and numbers', () => {
    expect(tokenize('def routes_command(self, sort: str) -> None:')).toEqual([
      'rout',
      'command',
      'sort',
    ]);
    expect(tokenize('Add a new CLI command that prints the configuration as JSON')).toEqual([
      'cli',
      'command',
      'print',
      'configuration',
      'json',
    ]);
    expect(tokenize('x = 42 + y1')).toEqual(['y1']);
  });

  it('counts term frequencies and estimates tokens', () => {
    expect(termFrequencies('config CONFIG loadConfig')).toEqual(
      new Map([
        ['config', 3],
        ['load', 1],
      ]),
    );
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('budgets', () => {
  it('reads the defaults from the swage.budgets setting in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    expect(DEFAULT_BUDGETS).toEqual(
      pkg.contributes.configuration.properties['swage.budgets']?.default,
    );
    expect(DEFAULT_BUDGETS).toMatchObject({
      hintsFiles: 5,
      toolResultTokens: 4000,
      readsPerRunTokens: 30000,
    });
  });

  it('merges a user setting and ignores invalid values', () => {
    expect(
      resolveBudgets({ hintsFiles: 3, toolResultTokens: -1, repoMapTokens: 'big', extra: 1 }),
    ).toEqual({
      ...DEFAULT_BUDGETS,
      hintsFiles: 3,
    });
    expect(resolveBudgets(undefined)).toEqual(DEFAULT_BUDGETS);
    expect(resolveBudgets({ readsPerRunTokens: 1.5 })).toEqual(DEFAULT_BUDGETS);
  });
});

describe('truncateToTokens', () => {
  it('returns short text unchanged', () => {
    expect(truncateToTokens('short\n', 10)).toEqual({
      text: 'short\n',
      truncated: false,
      tokens: 2,
      originalTokens: 2,
    });
  });

  it('cuts on a line boundary and appends a marker that says how to get more', () => {
    const text =
      Array.from({ length: 100 }, (_, i) => `line number ${i} of the file`).join('\n') + '\n';
    const r = truncateToTokens(text, 50);
    expect(r.truncated).toBe(true);
    expect(r.originalTokens).toBe(estimateTokens(text));
    const [body, marker] = [
      r.text.slice(0, r.text.indexOf(TRUNCATION_PREFIX)),
      r.text.slice(r.text.indexOf(TRUNCATION_PREFIX)),
    ];
    expect(body.endsWith('\n')).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(r.tokens).toBeLessThanOrEqual(50);
    expect(marker).toMatch(
      /^\[truncated: showing about \d+ of \d+ tokens \(lines 1-\d+ of 100\)\. To see more, request a line range/,
    );
    expect(truncateToTokens(text, 50, 'call repo_map with a path prefix').text).toMatch(
      /To see more, call repo_map with a path prefix\.\]$/,
    );
  });

  it('stays within the budget, marker included, and handles a single long line', () => {
    const long = 'x'.repeat(1000);
    const r = truncateToTokens(long, 100);
    expect(r.text.startsWith('xxxx')).toBe(true);
    expect(r.text).toContain(`\n${TRUNCATION_PREFIX}`);
    expect(r.tokens).toBeLessThanOrEqual(100);
    // A budget smaller than the marker still returns the marker, with nothing shown.
    expect(truncateToTokens(long, 10).text).toMatch(
      /^\[truncated: showing about 0 of 250 tokens \(0 of 1 lines\)/,
    );
  });
});

describe('ReadBudget', () => {
  it('refuses full reads past the budget but allows ranged reads', () => {
    const budget = new ReadBudget(100);
    expect(budget.charge('a.py', 60)).toEqual({ ok: true, used: 60, remaining: 40 });
    const refused = budget.charge('b.py', 50);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/line range/);
    expect(budget.used).toBe(60);
    expect(budget.charge('b.py', 50, { ranged: true })).toEqual({
      ok: true,
      used: 110,
      remaining: 0,
    });
    budget.reset();
    expect(budget.remaining).toBe(100);
    expect(new ReadBudget().limit).toBe(30000);
  });
});
