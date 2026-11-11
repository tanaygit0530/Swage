import { afterEach, describe, expect, it } from 'vitest';
import { CANCELLED_MESSAGE } from '../../src/agent/run';
import type { HostToWebview } from '../../src/ui/protocol';
import { treeHash } from '../mcp/harness';
import { startAgent, waitFor, type AgentHarness } from './harness';

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
const statuses = (posts: HostToWebview[]): string[] => of(posts, 'status').map((s) => s.state);
const allText = (posts: HostToWebview[]): string =>
  of(posts, 'text')
    .map((t) => t.delta)
    .join('');

describe('cancellation (blueprint section 8)', () => {
  it('cancels during streaming: UI flips at once, the stream drains to turn.done, workspace unchanged', async () => {
    h = await startAgent('streaming-cancel');
    const before = treeHash(h.root);
    const outcome = h.run.start('Explain the project.');
    await waitFor(() => of(h?.posts ?? [], 'text').length >= 3, 10_000, 'some streamed text');
    const textBefore = of(h.posts, 'text').length;
    const t0 = performance.now();
    const cancelling = h.run.cancel();
    const uiMs = performance.now() - t0;
    expect(statuses(h.posts).at(-1)).toBe('cancelled');
    expect(uiMs).toBeLessThan(50);
    await cancelling;
    expect(await outcome).toBe('cancelled');
    await waitFor(() => !h?.run.draining, 10_000, 'stream drained');
    expect(of(h.posts, 'text').length).toBe(textBefore);
    expect(
      of(h.posts, 'status')
        .filter((s) => s.state === 'cancelled')
        .map((s) => s.message),
    ).toEqual([CANCELLED_MESSAGE]);
    expect(h.fake.log).toContain('session.cancel sess-1');
    expect(h.ctx.tasks.get(h.run.taskId)?.cancelled).toBe(true);
    expect(treeHash(h.root)).toBe(before);
  });

  it('cancels during a long run_tests: the process tree is killed and the overlay discarded', async () => {
    h = await startAgent('long-tests');
    const before = treeHash(h.root);
    const outcome = h.run.start('Run the slow tests.');
    await waitFor(
      () => of(h?.posts ?? [], 'tool_start').some((t) => t.name === 'run_tests'),
      15_000,
      'run_tests to start',
    );
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    await h.run.cancel();
    expect(await outcome).toBe('cancelled');
    await waitFor(() => !h?.run.draining, 15_000, 'stream drained');
    // The slow test sleeps for two minutes; draining must not wait for it.
    expect(Date.now() - t0).toBeLessThan(10_000);
    const task = h.ctx.tasks.get(h.run.taskId);
    expect(task?.cancelled).toBe(true);
    expect(task?.changeSet.status).toBe('discarded');
    expect(task?.changeSet.stagedPaths()).toEqual([]);
    expect(treeHash(h.root)).toBe(before);
  }, 30_000);

  it('drops stale events that arrive after a cancel', async () => {
    h = await startAgent('streaming-cancel', { staleEventAfterCancel: true });
    const before = treeHash(h.root);
    const outcome = h.run.start('Explain the project.');
    await waitFor(() => of(h?.posts ?? [], 'text').length >= 2, 10_000, 'some text');
    await h.run.cancel();
    expect(await outcome).toBe('cancelled');
    await waitFor(() => !h?.run.draining, 10_000, 'stream drained');
    expect(allText(h.posts)).not.toContain('STALE');
    expect(of(h.posts, 'tool_end')).toEqual([]);
    expect(h.run.dropped).toBeGreaterThanOrEqual(2);
    expect(treeHash(h.root)).toBe(before);
  });

  it('handles a new turn in the same session cancelling the running one', async () => {
    h = await startAgent('streaming-cancel');
    const before = treeHash(h.root);
    const outcome = h.run.start('Explain the project.');
    await waitFor(() => of(h?.posts ?? [], 'text').length >= 2, 10_000, 'some text');
    // Another client starts a turn in the same session; TrueForge cancels ours.
    const other = await h.fake.sessions.createTurnStream(h.run.session ?? '', {
      input: [{ type: 'user.message', content: 'other' }],
    });
    const drainOther = (async () => {
      for await (const e of other) void e;
    })();
    expect(await outcome).toBe('cancelled');
    expect(of(h.posts, 'status').at(-1)?.message).toBe('This turn was replaced by a newer one.');
    expect(h.ctx.tasks.get(h.run.taskId)?.cancelled).toBe(true);
    await h.fake.sessions.cancel(h.run.session ?? '');
    await drainOther;
    expect(treeHash(h.root)).toBe(before);
  });
});
