import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { FLASK_TASKS } from './tasks';

/**
 * Blueprint G16 on the real target: recall@10 of 0.8 or better on Flask 3.1.3, an index
 * build under 2 s and a warm query under 300 ms. Set SWAGE_FLASK_DIR to run it.
 */
const FLASK = process.env.SWAGE_FLASK_DIR;
const enabled = FLASK !== undefined && existsSync(path.join(FLASK, 'src', 'flask', 'cli.py'));

describe.skipIf(!enabled)('retrieval evaluation on Flask 3.1.3', () => {
  it('meets recall@10 >= 0.8, a 2 s index build and 300 ms queries', async () => {
    const index = new WorkspaceIndex({
      root: FLASK ?? '',
      parser: await createParser(),
      cache: null,
    });
    const build = await index.build();
    const searcher = new Bm25Searcher(index);
    searcher.search('warm up');

    const lines: string[] = [];
    let r5 = 0;
    let r10 = 0;
    let maxMs = 0;
    let totalMs = 0;
    for (const task of FLASK_TASKS) {
      const t0 = performance.now();
      const hits = searcher.search(task.query, { limit: 10 });
      const ms = performance.now() - t0;
      maxMs = Math.max(maxMs, ms);
      totalMs += ms;
      const top = hits.map((h) => h.path);
      const at = (k: number): number =>
        task.expected.filter((e) => top.slice(0, k).includes(e)).length / task.expected.length;
      r5 += at(5);
      r10 += at(10);
      const ranks = task.expected.map(
        (e) => `${e.split('/').pop() ?? e}#${top.indexOf(e) + 1 || '-'}`,
      );
      lines.push(
        `${task.id.padEnd(22)} ${at(5).toFixed(2)}  ${at(10).toFixed(2)}  ${ms.toFixed(1).padStart(5)} ms  ${ranks.join(' ')}`,
      );
    }
    const n = FLASK_TASKS.length;
    console.log(
      [
        '',
        `Flask 3.1.3: ${build.files} files indexed in ${build.ms.toFixed(0)} ms (${index.parserEngine})`,
        'task                   @5    @10   query     ranks',
        ...lines,
        `mean recall@5 ${(r5 / n).toFixed(3)}, recall@10 ${(r10 / n).toFixed(3)}; query mean ${(totalMs / n).toFixed(1)} ms, max ${maxMs.toFixed(1)} ms`,
      ].join('\n'),
    );
    expect(r10 / n).toBeGreaterThanOrEqual(0.8);
    expect(build.ms).toBeLessThan(2000);
    expect(maxMs).toBeLessThan(300);
  }, 30_000);
});
