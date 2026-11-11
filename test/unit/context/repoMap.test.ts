import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../../src/context/indexer';
import { buildRepoMap } from '../../../src/context/repoMap';
import { createParser } from '../../../src/context/symbols';

const FIXTURE = path.join(__dirname, '..', '..', 'retrieval-eval', 'fixture');
let index: WorkspaceIndex;

beforeAll(async () => {
  index = new WorkspaceIndex({ root: FIXTURE, parser: await createParser(), cache: null });
  await index.build();
});

describe('buildRepoMap', () => {
  it('lists every fixture file with top symbols within the default 1,500-token budget', () => {
    const map = buildRepoMap(index);
    expect(map.tokens).toBeLessThanOrEqual(1500);
    expect(map.omitted).toBe(0);
    expect(map.files).toHaveLength(index.size);
    expect(map.text.split('\n')[0]).toMatch(/^Repository map \(40 files/);
    expect(map.text).toContain(
      'taskboard/config.py: Config, parse_bool, read_env_file, load_config, DEFAULTS, FALSE_VALUES',
    );
    expect(map.text).toContain(
      'web/src/store.ts: visibleTasks, sortByDueDate, Task, TaskState, Priority',
    );
    expect(map.text).toMatch(/^docs\/cli\.md$/m);
  });

  it('puts widely imported source files before tests', () => {
    const { files } = buildRepoMap(index);
    expect(files.indexOf('taskboard/models.py')).toBeLessThan(files.indexOf('tests/test_cli.py'));
    expect(files.indexOf('web/src/store.ts')).toBeLessThan(
      files.indexOf('web/src/components/TaskForm.tsx'),
    );
  });

  it('drops the lowest-ranked files under a small budget and says how to see them', () => {
    const map = buildRepoMap(index, { maxTokens: 200 });
    expect(map.tokens).toBeLessThanOrEqual(200);
    expect(map.omitted).toBeGreaterThan(0);
    expect(map.files.length + map.omitted).toBe(index.size);
    expect(map.text).toMatch(/\.\.\. \d+ more files omitted\. Call repo_map with a path prefix/);
  });

  it('ranks files from a search first and filters by prefix', () => {
    const ranked = buildRepoMap(index, { rank: new Map([['taskboard/utils/slugify.py', 5]]) });
    expect(ranked.files[0]).toBe('taskboard/utils/slugify.py');

    const web = buildRepoMap(index, { pathPrefix: 'web/' });
    expect(web.files.every((f) => f.startsWith('web/'))).toBe(true);
    expect(web.text.split('\n')[0]).toMatch(/^Repository map of web\//);
  });

  it('caps symbols per file and hides private names', () => {
    const map = buildRepoMap(index, { maxSymbolsPerFile: 2 });
    expect(map.text).toContain('taskboard/config.py: Config, parse_bool, +4');
    expect(map.text).not.toContain('_NON_WORD');
  });
});
