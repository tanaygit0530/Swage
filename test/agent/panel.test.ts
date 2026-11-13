import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '../../src/ui/protocol';
import { startAgent, type AgentHarness } from './harness';

/** What a run posts for the redesigned panel: edited-file cards, the bar, the walkthrough. */

let h: AgentHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const of = <T extends HostToWebview['type']>(
  posts: HostToWebview[],
  type: T,
): Extract<HostToWebview, { type: T }>[] =>
  posts.filter((p): p is Extract<HostToWebview, { type: T }> => p.type === type);

describe('panel messages from an agent run', () => {
  it('posts a card and a live bar row per staged file, then the walkthrough at review', async () => {
    const staged: string[] = [];
    let reviewed = false;
    h = await startAgent(
      'three-file-edit',
      {},
      {
        onStaged: (_task, _cs, path) => staged.push(path),
        review: () => {
          reviewed = true;
          return new Promise(() => undefined);
        },
      },
    );
    expect(await h.run.start('Add a config command; test and document it.')).toBe('paused');
    const edits = of(h.posts, 'edit');
    expect(edits.map((e) => e.path)).toEqual(['app/cli.py', 'tests/test_cli.py', 'docs/cli.md']);
    expect(edits.every((e) => e.added > 0 && e.reason)).toBe(true);
    expect(staged).toEqual(['app/cli.py', 'tests/test_cli.py', 'docs/cli.md']);
    const bars = of(h.posts, 'changes');
    expect(bars.map((b) => b.files.length)).toEqual([1, 2, 3]);
    expect(bars.every((b) => b.phase === 'staging')).toBe(true);
    // Ordered by path, whatever the staging order.
    expect(bars.at(-1)?.files.map((f) => f.path)).toEqual([
      'app/cli.py',
      'docs/cli.md',
      'tests/test_cli.py',
    ]);
    const walk = of(h.posts, 'walkthrough');
    expect(walk).toHaveLength(1);
    expect(walk[0]?.summary.length).toBeGreaterThan(0);
    expect(walk[0]?.files).toHaveLength(3);
    expect(reviewed).toBe(true);
  });

  it('empties the bar when the run is cancelled', async () => {
    const dropped: string[] = [];
    h = await startAgent('three-file-edit', {}, { onDropped: (t) => dropped.push(t) });
    const started = h.run.start('Add a config command.');
    await h.run.cancel();
    await started;
    expect(of(h.posts, 'changes').at(-1)).toEqual({ type: 'changes', phase: 'none', files: [] });
    expect(dropped).toEqual([h.run.taskId]);
  });
});
