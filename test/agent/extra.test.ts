import { afterEach, describe, expect, it } from 'vitest';
import { buildFirstMessage } from '../../src/agent/context';
import { EventRelay } from '../../src/agent/relay';
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

describe('EventRelay', () => {
  it('forwards every tool event to the attached run only', () => {
    const relay = new EventRelay();
    const seen: string[] = [];
    relay.onDeclare('t', [], []);
    const first = relay.attach({
      onDeclare: (t) => seen.push(`declare ${t}`),
      onStage: (t, p) => seen.push(`stage ${t} ${p}`),
      onSubmit: (t, s) => seen.push(`submit ${t} ${s}`),
      onCommand: (t, c, o) => seen.push(`command ${t} ${c} ${o}`),
    });
    relay.onDeclare('t1', ['p'], []);
    relay.onStage('t1', 'a.py');
    relay.onSubmit('t1', 'sum');
    relay.onCommand('t1', 'ls', 'approved');
    const second = relay.attach({});
    first.dispose(); // An old subscription must not detach the newer one.
    relay.onStage('t2', 'b.py');
    second.dispose();
    relay.onStage('t3', 'c.py');
    expect(seen).toEqual([
      'declare t1',
      'stage t1 a.py',
      'submit t1 sum',
      'command t1 ls approved',
    ]);
  });
});

describe('first message', () => {
  it('includes mentioned files and lists mentions that did not resolve', async () => {
    h = await startAgent('approval');
    const first = await buildFirstMessage('Change @app/cli.py and @nowhere_symbol', h.ctx);
    expect(first.text).toContain('<<<FILE app/cli.py lines 1-');
    expect(first.text).toContain('Mentions that did not resolve: @nowhere_symbol');
    expect(first.text).toContain('Candidate files from retrieval');
    expect(first.parts.find((p) => p.label === 'mentions')?.tokens).toBeGreaterThan(0);
    expect(first.total).toBeGreaterThan(first.used);
  });
});

describe('agent run edge cases', () => {
  it('approving run_command hands the approved command to the tool, which runs it in a shadow copy', async () => {
    h = await startAgent({
      name: 'run-command',
      steps: [
        {
          toolCalls: [
            {
              name: 'call_tool',
              arguments: {
                mcp_server: 'editor-tools',
                tool_name: 'run_command',
                input: { command: `${process.execPath} check.js`, reason: 'check the docs' },
              },
            },
          ],
        },
        { text: ['Ran it.'] },
      ],
    });
    const before = treeHash(h.root);
    expect(await h.run.start('Run the checker.')).toBe('paused');
    const card = of(h.posts, 'approval')[0]?.calls[0];
    expect(card?.name).toBe('run_command');
    expect(card?.summary).toContain('check.js');
    expect(card?.summary).toContain('Reason: check the docs');
    expect(await h.run.decide(card?.toolCallId ?? '', true)).toBe('done');
    const end = of(h.posts, 'tool_end').at(-1);
    expect(end?.error).toBe(false);
    expect(treeHash(h.root)).toBe(before);
  });

  it('reports a failure to open the TrueForge session as one line', async () => {
    h = await startAgent('approval');
    (h.fake.sessions as unknown as { create: () => Promise<never> }).create = () =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8790\n    at stack'));
    expect(await h.run.start('Anything.')).toBe('error');
    expect(of(h.posts, 'status').at(-1)?.message).toBe('connect ECONNREFUSED 127.0.0.1:8790');
  });

  it('stops before opening a session when Stop is pressed during context assembly', async () => {
    h = await startAgent('approval');
    const outcome = h.run.start('Anything.');
    await h.run.cancel();
    expect(await outcome).toBe('cancelled');
    expect(h.fake.log.filter((l) => l.startsWith('session.create'))).toEqual([]);
    expect(h.run.session).toBeUndefined();
    expect(h.run.request).toBe('Anything.');
    await h.run.cancel();
  });
});
