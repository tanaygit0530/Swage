import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '../../src/ui/protocol';
import { treeHash } from '../mcp/harness';
import { startAgent, type AgentHarness } from './harness';

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

describe('agent run with the scripted model', () => {
  it('runs a normal three-file edit: plan, tools, tests, approval, done; nothing written to disk', async () => {
    h = await startAgent('three-file-edit');
    const before = treeHash(h.root);
    expect(
      await h.run.start(
        'Add a config command that prints the configuration with secrets masked; test and document it.',
      ),
    ).toBe('paused');

    const posts = h.posts;
    expect(of(posts, 'user')[0]?.text).toMatch(/^Add a config command/);
    const budget = of(posts, 'budget')[0];
    expect(budget?.parts.map((p) => p.label)).toEqual([
      'request',
      'mentions',
      'repo map',
      'hints',
      'file reads',
    ]);
    expect(budget?.used).toBeGreaterThan(0);
    expect(allText(posts)).toContain(
      "I'll look for the CLI code first.Plan: add the command, test it, document it.",
    );
    expect(of(posts, 'plan')[0]?.files.map((f) => f.path)).toEqual([
      'app/cli.py',
      'tests/test_cli.py',
      'docs/cli.md',
    ]);
    const tools = of(posts, 'tool_start').map((t) => t.name);
    expect(tools).toEqual([
      'find_relevant_code',
      'read_files',
      'declare_context',
      'stage_edit',
      'stage_edit',
      'stage_edit',
      'run_tests',
      'submit_change_set',
    ]);
    const ends = of(posts, 'tool_end');
    expect(ends).toHaveLength(7);
    expect(ends.every((e) => !e.error && e.resultChars > 0)).toBe(true);
    // The budget meter updates after file reads.
    expect(of(posts, 'budget').at(-1)?.parts.at(-1)?.tokens).toBeGreaterThan(0);
    const approval = of(posts, 'approval')[0];
    expect(approval?.calls[0]?.name).toBe('submit_change_set');
    expect(approval?.calls[0]?.summary).toContain('modify app/cli.py (1 block(s))');
    expect(statuses(posts).at(-1)).toBe('paused');
    expect(treeHash(h.root)).toBe(before);

    const id = approval?.calls[0]?.toolCallId ?? '';
    expect(await h.run.decide(id, true)).toBe('done');
    expect(of(posts, 'approval_resolved')).toEqual([
      { type: 'approval_resolved', toolCallId: id, allowed: true },
    ]);
    expect(allText(posts)).toContain('The change set is ready for your review.');
    expect(statuses(posts).at(-1)).toBe('done');
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.status).toBe('submitted');
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.stagedPaths()).toEqual([
      'app/cli.py',
      'tests/test_cli.py',
      'docs/cli.md',
    ]);
    expect(treeHash(h.root)).toBe(before);
    expect(h.logs.some((l) => /^context assembled in \d+ ms/.test(l))).toBe(true);
  });

  it('approval allow runs submit_change_set and finishes', async () => {
    h = await startAgent('approval');
    expect(await h.run.start('Document the config command.')).toBe('paused');
    const call = of(h.posts, 'approval')[0]?.calls[0];
    expect(call?.name).toBe('submit_change_set');
    expect(await h.run.decide(call?.toolCallId ?? '', true)).toBe('done');
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.status).toBe('submitted');
    expect(allText(h.posts)).toContain('Understood.');
    expect(h.fake.log).toContain('turn user.tool_approval');
  });

  it('approval deny reports the denial to the agent and nothing is submitted', async () => {
    h = await startAgent('approval');
    const before = treeHash(h.root);
    expect(await h.run.start('Document the config command.')).toBe('paused');
    const call = of(h.posts, 'approval')[0]?.calls[0];
    expect(await h.run.decide(call?.toolCallId ?? '', false, 'Not now')).toBe('done');
    expect(of(h.posts, 'approval_resolved')[0]?.allowed).toBe(false);
    expect(h.ctx.tasks.get(h.run.taskId)?.changeSet.status).toBe('staging');
    expect(of(h.posts, 'status').at(-1)?.message).toBe(
      'The agent finished without submitting; 1 file(s) are staged.',
    );
    expect(treeHash(h.root)).toBe(before);
    // A decision for an unknown call or after the run is ignored.
    expect(await h.run.decide('nope', true)).toBeUndefined();
  });

  it('shows a model error as one short line and leaves the workspace unchanged', async () => {
    h = await startAgent('rate-limit');
    const before = treeHash(h.root);
    expect(await h.run.start('Anything.')).toBe('error');
    const last = of(h.posts, 'status').at(-1);
    expect(last?.message).toBe(
      '[Model Error] Request failed (429): Rate limit reached for requests. Please try again in 1s.',
    );
    expect(h.ctx.tasks.get(h.run.taskId)?.cancelled).toBe(true);
    expect(treeHash(h.root)).toBe(before);
    // Cancel after the run ended is a no-op.
    await h.run.cancel();
    expect(statuses(h.posts).filter((s) => s === 'cancelled')).toEqual([]);
  });
});
