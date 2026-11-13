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

describe('Planning mode (declare_context needs approval)', () => {
  it('pauses on the plan, stages nothing until Approve, then runs on', async () => {
    h = await startAgent('three-file-edit', {
      gated: ['submit_change_set', 'run_command', 'declare_context'],
    });
    expect(await h.run.start('Add a config command; test and document it.')).toBe('paused');
    const card = of(h.posts, 'plan')[0];
    expect(card).toMatchObject({ awaiting: true });
    expect(card?.files.map((f) => f.path)).toEqual([
      'app/cli.py',
      'tests/test_cli.py',
      'docs/cli.md',
    ]);
    expect(h.run.pendingCalls.map((c) => c.name)).toEqual(['declare_context']);
    // No approval card for the plan, and nothing staged yet.
    expect(of(h.posts, 'approval')).toEqual([]);
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.stagedPaths()).toEqual([]);
    expect(of(h.posts, 'status').at(-1)?.message).toMatch(/Review the plan/);

    const outcome = await h.run.decidePlan(card?.toolCallId ?? '', true);
    expect(outcome).toBe('paused');
    // The approved declaration does not post a second plan card.
    expect(of(h.posts, 'plan')).toHaveLength(1);
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.stagedPaths().length).toBeGreaterThan(0);
    expect(h.run.pendingCalls.map((c) => c.name)).toEqual(['submit_change_set']);
  });

  it('sends the plan back with the user feedback on Edit', async () => {
    h = await startAgent('three-file-edit', {
      gated: ['submit_change_set', 'run_command', 'declare_context'],
    });
    await h.run.start('Add a config command.');
    const id = of(h.posts, 'plan')[0]?.toolCallId ?? '';
    expect(await h.run.decidePlan('not-a-plan', true)).toBeUndefined();
    void h.run.decidePlan(id, false, 'also update the README');
    await new Promise((r) => setTimeout(r, 300));
    expect(of(h.posts, 'approval_resolved')[0]).toEqual({
      type: 'approval_resolved',
      toolCallId: id,
      allowed: false,
    });
    // The agent sees the denial with the user's words as the tool result.
    expect(
      of(h.posts, 'tool_end').some((e) =>
        e.result?.includes('revise the plan: also update the README'),
      ),
    ).toBe(true);
  });
});

describe('Planning mode: re-declarations', () => {
  it('lets later declarations pass once a plan was approved, and reads loose plan arguments', async () => {
    const declare = (files: unknown[], plan: unknown[]) => ({
      toolCalls: [{ name: 'declare_context', arguments: { plan, files } }],
    });
    h = await startAgent(
      {
        name: 'redeclare',
        description: 'declares twice',
        steps: [
          declare([{ path: 'app/cli.py', reason: 'the CLI' }, { path: 7 }, null], ['Add it', 3]),
          declare(
            [
              { path: 'app/cli.py', reason: 'the CLI' },
              { path: 'docs/cli.md', reason: 'the docs' },
            ],
            ['Add it', 'Document it'],
          ),
          { text: ['Done.'] },
        ],
      } as never,
      { gated: ['submit_change_set', 'run_command', 'declare_context'] },
    );
    expect(await h.run.start('Add a config command.')).toBe('paused');
    const card = of(h.posts, 'plan')[0];
    expect(card?.steps).toEqual(['Add it']);
    expect(card?.files).toEqual([{ path: 'app/cli.py', reason: 'the CLI' }]);
    expect(await h.run.decidePlan(card?.toolCallId ?? '', true)).toBe('done');
    // The second declaration ran without a card, and its plan shows as a read-only card.
    const plans = of(h.posts, 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1]?.awaiting).toBeUndefined();
    expect(plans[1]?.files.map((f) => f.path)).toEqual(['app/cli.py', 'docs/cli.md']);
  });
});
