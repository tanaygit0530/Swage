import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex, type BuildStats } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { FIXTURE_TASKS } from './tasks';

/**
 * Retrieval evaluation (blueprint section 7, G16). Indexes the vendored fixture, runs every
 * labelled task and reports recall at 5, the token cost of reading the top five files, and
 * timings. Fails if recall at 5 drops below 0.8.
 */

const FIXTURE = path.join(__dirname, 'fixture');
const K = 5;
const MIN_RECALL = 0.8;

interface Row {
  id: string;
  recall: number;
  missed: string[];
  tokens: number;
  ms: number;
}

let index: WorkspaceIndex;
let searcher: Bm25Searcher;
let coldBuild: BuildStats;
const rows: Row[] = [];

beforeAll(async () => {
  const parser = await createParser();
  index = new WorkspaceIndex({ root: FIXTURE, parser, cache: null });
  coldBuild = await index.build();
  searcher = new Bm25Searcher(index);
  searcher.search('warm up');
  for (const task of FIXTURE_TASKS) {
    const t0 = performance.now();
    const hits = searcher.search(task.query, { limit: K });
    const ms = performance.now() - t0;
    const top = hits.map((h) => h.path);
    const missed = task.expected.filter((e) => !top.includes(e));
    rows.push({
      id: task.id,
      recall: (task.expected.length - missed.length) / task.expected.length,
      missed,
      tokens: hits.reduce((n, h) => n + h.estimatedTokens, 0),
      ms,
    });
  }
});

describe('retrieval evaluation on the fixture project', () => {
  it('labels at least 15 tasks whose expected files exist in the index', () => {
    expect(FIXTURE_TASKS.length).toBeGreaterThanOrEqual(15);
    for (const task of FIXTURE_TASKS) {
      for (const file of task.expected)
        expect(index.get(file), `${task.id}: ${file}`).toBeDefined();
    }
  });

  it(`keeps mean recall at ${K} at or above ${MIN_RECALL}`, () => {
    const mean = rows.reduce((s, r) => s + r.recall, 0) / rows.length;
    const full = rows.filter((r) => r.recall === 1).length;
    const tokens = rows.reduce((s, r) => s + r.tokens, 0) / rows.length;
    const queryMs = rows.reduce((s, r) => s + r.ms, 0) / rows.length;
    const maxMs = Math.max(...rows.map((r) => r.ms));

    const lines = [
      '',
      `Retrieval evaluation: ${rows.length} tasks, ${coldBuild.files} files indexed (${index.parserEngine})`,
      'task                 recall@5  top-5 tokens  ms     missed',
      ...rows.map(
        (r) =>
          `${r.id.padEnd(20)} ${r.recall.toFixed(2).padStart(8)}  ${String(r.tokens).padStart(12)}  ${r.ms.toFixed(2).padStart(5)}  ${r.missed.join(', ')}`,
      ),
      `mean recall@5: ${mean.toFixed(3)} (${full}/${rows.length} tasks fully found)`,
      `mean token cost of the top 5 files: ${Math.round(tokens)} tokens`,
      `index build (cold): ${coldBuild.ms.toFixed(1)} ms; query: mean ${queryMs.toFixed(2)} ms, max ${maxMs.toFixed(2)} ms`,
    ];
    console.log(lines.join('\n'));
    expect(mean).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it('answers a warm query in well under 300 ms', () => {
    expect(Math.max(...rows.map((r) => r.ms))).toBeLessThan(300);
  });
});
