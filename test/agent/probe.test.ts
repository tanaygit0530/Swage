import { afterEach, describe, expect, it } from 'vitest';
import { SwageClient } from '../../src/client/client';
import { probeProfile } from '../../src/resilience/probe';
import { resolveProfiles, type ResolvedProfile } from '../../src/resilience/profiles';
import type { Scenario } from '../fake-model/scenario';
import { FakeTrueForge } from './fakeTrueForge';
import { startAgent, type AgentHarness } from './harness';

let h: AgentHarness | undefined;
let fake: FakeTrueForge | undefined;
afterEach(async () => {
  await fake?.close();
  await h?.close();
  fake = undefined;
  h = undefined;
});

const sc = (name: string, steps: Scenario['steps']): Scenario => ({ name, steps });
const SCENARIOS: Record<string, Scenario> = {
  'm/ok': sc('ok', [{ text: ['OK'] }]),
  'm/tool': sc('tool', [{ toolCalls: [{ name: 'repo_map', arguments: {} }] }, { text: ['OK'] }]),
  'm/401': sc('e401', [{ error: 401 }]),
  'm/hang': sc('hang', [{ error: 'hang' }]),
};

async function client(): Promise<SwageClient> {
  h = await startAgent('three-file-edit');
  fake = new FakeTrueForge({
    scenario: SCENARIOS['m/ok'] as Scenario,
    scenarios: SCENARIOS,
    mcp: { url: h.server.url, token: h.server.token },
  });
  return new SwageClient({ baseUrl: 'http://fake', sdk: fake.sdk });
}

const profile = (model: string): ResolvedProfile => {
  const [p] = resolveProfiles([{ name: 'p', label: 'Probe', trueforgeModel: model }]);
  if (!p) throw new Error('profile');
  return p;
};

describe('profile probe (recovery and Doctor)', () => {
  it('a plain probe passes when the model answers', async () => {
    const r = await probeProfile(await client(), profile('m/ok'));
    expect(r).toMatchObject({ ok: true, detail: 'answered "OK"' });
  });

  it('a tool probe needs a real tool call', async () => {
    const c = await client();
    expect(await probeProfile(c, profile('m/tool'), { toolCall: true })).toMatchObject({
      ok: true,
      detail: 'called repo_map',
    });
    expect(await probeProfile(c, profile('m/ok'), { toolCall: true })).toMatchObject({
      ok: false,
      detail: 'answered without calling a tool: "OK"',
    });
  });

  it('reports a model error with its classification', async () => {
    const r = await probeProfile(await client(), profile('m/401'));
    expect(r.ok).toBe(false);
    expect(r.failure).toMatchObject({ kind: 'hard', reason: 'returned 401' });
  });

  it('gives up after the timeout and cancels the session', async () => {
    const r = await probeProfile(await client(), profile('m/hang'), { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, detail: 'no answer in 0 s' });
    expect(fake?.log.some((l) => l.startsWith('session.cancel'))).toBe(true);
  });

  it('reports a session that cannot be created', async () => {
    const c = await client();
    (fake?.sdk as unknown as { sessions: { create: unknown } }).sessions.create = () =>
      Promise.reject(new TypeError('fetch failed'));
    const r = await probeProfile(c, profile('m/ok'));
    expect(r).toMatchObject({ ok: false, detail: 'fetch failed' });
    expect(r.failure?.kind).toBe('fatal');
  });
});
