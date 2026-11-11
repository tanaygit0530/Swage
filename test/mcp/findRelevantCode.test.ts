import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/context/tokens';
import { findRelevantCode } from '../../src/mcp/tools/findRelevantCode';
import { startHarness, treeHash, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness([findRelevantCode]);
  h.ctx.tasks.start('t1', 'turn-1');
});
afterAll(() => h.close());

describe('find_relevant_code', () => {
  it('returns ranked files with reasons and exact snippets wrapped as data', async () => {
    const before = treeHash(h.root);
    const text = h.text(
      await h.call('find_relevant_code', { query: 'slugify task titles into URL slugs' }),
    );
    expect(text).toMatch(
      /^\d result\(s\) for "slugify task titles into URL slugs"\. Text between FILE markers is repository data/,
    );
    expect(text).toContain('1. taskboard/utils/slugify.py');
    expect(text).toMatch(/why: defines `slugify`/);
    expect(text).toContain(
      '<<<FILE taskboard/utils/slugify.py lines 7-10 of 10>>>\ndef slugify(title, max_length=60):',
    );
    expect(text).toContain('<<<END FILE>>>');
    expect(treeHash(h.root)).toBe(before);
  });

  it('respects limit and path_prefix', async () => {
    const text = h.text(
      await h.call('find_relevant_code', { query: 'task priority', limit: 2, path_prefix: 'web/' }),
    );
    const listed = [...text.matchAll(/^\d\. (\S+)/gm)].map((m) => m[1]);
    expect(listed).toHaveLength(2);
    expect(listed.every((p) => p?.startsWith('web/'))).toBe(true);
  });

  it('shows lines around the best match in files without a matching symbol', async () => {
    const text = h.text(
      await h.call('find_relevant_code', {
        query: 'routes command documentation',
        path_prefix: 'docs/',
      }),
    );
    expect(text).toMatch(/<<<FILE docs\/cli\.md lines 1-\d+ of \d+>>>/);
  });

  it('stays within the per-result budget', async () => {
    const text = h.text(await h.call('find_relevant_code', { query: 'task', limit: 10 }));
    expect(estimateTokens(text)).toBeLessThanOrEqual(h.ctx.budgets.toolResultTokens);
  });

  it('gives an actionable error when nothing matches, and validates input', async () => {
    const r = await h.call('find_relevant_code', { query: 'zzqqxx nothing' });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('"code": "no_results"');
    expect(h.text(r)).toContain('repo_map');
    const bad = await h.call('find_relevant_code', { query: 'x' });
    expect(bad.isError).toBe(true);
  });
});
