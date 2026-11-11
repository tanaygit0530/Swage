import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/context/tokens';
import { repoMap } from '../../src/mcp/tools/repoMap';
import { startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness([repoMap]);
  h.ctx.tasks.start('t1');
});
afterAll(() => h.close());

describe('repo_map', () => {
  it('maps the repository within the repo-map budget', async () => {
    const text = h.text(await h.call('repo_map'));
    expect(text.split('\n')[0]).toMatch(/^Repository map \(40 files/);
    expect(text).toContain('taskboard/config.py: Config, parse_bool');
    expect(estimateTokens(text)).toBeLessThanOrEqual(1500);
  });

  it('zooms into a folder and honours a smaller budget', async () => {
    const web = h.text(await h.call('repo_map', { path_prefix: './web/' }));
    expect(web.split('\n')[0]).toMatch(/^Repository map of web\//);
    expect(web).not.toContain('taskboard/');
    const small = h.text(await h.call('repo_map', { max_tokens: 200 }));
    expect(small).toMatch(/more files omitted/);
  });

  it('explains an empty prefix and rejects a silly budget', async () => {
    const r = await h.call('repo_map', { path_prefix: 'nope/' });
    expect(h.text(r)).toContain('"code": "no_files"');
    expect((await h.call('repo_map', { max_tokens: 5 })).isError).toBe(true);
  });
});
