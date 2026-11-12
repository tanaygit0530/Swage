import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRelay } from '../../src/agent/relay';
import { AgentRun, CANCELLED_MESSAGE } from '../../src/agent/run';
import { SwageClient } from '../../src/client/client';
import { agentPreparer, loadManifests } from '../../src/client/setup';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { ApprovalList, createToolContext, type ToolContext } from '../../src/mcp/context';
import { startEditorToolsServer, type EditorToolsServer } from '../../src/mcp/server';
import { EDITOR_TOOLS } from '../../src/mcp/tools/index';
import { ModelRouter, type Decision } from '../../src/resilience/fallback';
import { resolveProfiles } from '../../src/resilience/profiles';
import type { HostToWebview } from '../../src/ui/protocol';
import { loadScenarios, type Scenario, type ScenarioStep } from '../fake-model/scenario';
import { treeHash } from '../mcp/harness';
import { DEMO, waitFor } from './harness';
import { FakeTrueForge } from './fakeTrueForge';

/**
 * Resilience with the scripted model (blueprint section 8): every failure kind on the primary,
 * and what the run does about it. Timers are scaled down; the logic is the production path.
 */

const scenarios = new Map(loadScenarios().map((s) => [s.name, s]));
const THREE = scenarios.get('three-file-edit') as Scenario;
const step = (i: number): ScenarioStep => THREE.steps[i] as ScenarioStep;
const REQUEST =
  'Add a config command that prints the configuration with secrets masked; test and document it.';

/** Switch measurements, printed for docs/PROGRESS.md with SWAGE_PRINT_SWITCH=1. */
const measured: { case: string; detectMs: number; resumeMs: number | undefined }[] = [];

interface ProfileSpec {
  readonly name: string;
  readonly label: string;
  readonly model: string;
  readonly scenario: Scenario;
  readonly kind?: 'hosted' | 'local';
  readonly timeouts?: Record<string, number>;
}

interface World {
  readonly root: string;
  readonly ctx: ToolContext;
  readonly fake: FakeTrueForge;
  readonly server: EditorToolsServer;
  readonly router: ModelRouter;
  readonly run: AgentRun;
  readonly posts: HostToWebview[];
  readonly times: number[];
  readonly switches: { decision: Extract<Decision, { action: 'switch' }>; at: number }[];
  readonly t0: number;
  close(): Promise<void>;
}

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const FAST = { connectMs: 2000, firstTokenMs: 2000, stallMs: 2000, totalMs: 30_000 };

function s(name: string, steps: ScenarioStep[]): Scenario {
  return { name, steps };
}

async function world(
  profiles: ProfileSpec[],
  retries = 2,
  routerOptions: { maxRetryWaitMs?: number; maxQuotaWaitMs?: number } = {},
): Promise<World> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-res-')));
  cpSync(DEMO, root, { recursive: true });
  const index = new WorkspaceIndex({ root, parser: await createParser(), cache: null });
  await index.build();
  const relay = new EventRelay();
  const approvals = new ApprovalList();
  const ctx = createToolContext({
    root,
    index,
    searcher: new Bm25Searcher(index),
    events: relay,
    approvals,
  });
  const server = await startEditorToolsServer({ context: ctx, tools: EDITOR_TOOLS });
  const fake = new FakeTrueForge({
    scenario: profiles[0]?.scenario as Scenario,
    scenarios: Object.fromEntries(profiles.map((p) => [p.model, p.scenario])),
    mcp: { url: server.url, token: server.token },
  });
  const client = new SwageClient({ baseUrl: 'http://fake', sdk: fake.sdk });
  const router = new ModelRouter(
    resolveProfiles(
      profiles.map((p) => ({
        name: p.name,
        label: p.label,
        kind: p.kind ?? 'hosted',
        trueforgeModel: p.model,
        timeouts: p.timeouts ?? FAST,
      })),
    ),
    { retries, backoff: { baseMs: 20, maxMs: 100, jitter: 0 }, ...routerOptions },
  );
  const posts: HostToWebview[] = [];
  const times: number[] = [];
  const switches: World['switches'] = [];
  const run = new AgentRun({
    client,
    ctx,
    relay,
    approvals,
    agentName: 'unused',
    view: {
      post: (m) => {
        posts.push(m);
        times.push(performance.now());
      },
    },
    router,
    agentBase: 'swage-main',
    prepareAgent: agentPreparer(
      client,
      loadManifests(path.join(__dirname, '..', '..', 'trueforge', 'agents')),
    ),
    onSwitch: (decision) => switches.push({ decision, at: performance.now() }),
    drainTimeoutMs: 5000,
  });
  return {
    root,
    ctx,
    fake,
    server,
    router,
    run,
    posts,
    times,
    switches,
    t0: performance.now(),
    close: async () => {
      await run.cancel();
      await fake.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const of = <T extends HostToWebview['type']>(
  posts: HostToWebview[],
  type: T,
): Extract<HostToWebview, { type: T }>[] =>
  posts.filter((p): p is Extract<HostToWebview, { type: T }> => p.type === type);
const notices = (x: World): string[] => of(x.posts, 'notice').map((n) => n.message);
const statusMessages = (x: World): string[] => of(x.posts, 'status').map((n) => n.message ?? '');
const errorsOn = (x: World, model: string): number =>
  x.fake.log.filter((l) => l.startsWith(`model.error ${model} `)).length;

/** Time from start to the switch, and from the switch to the fallback's first event. */
function measure(name: string, x: World): void {
  const sw = x.switches[0];
  if (!sw) return;
  const after = x.posts.findIndex((p) => p.type === 'notice');
  const next = x.posts.findIndex(
    (p, i) => i > after && (p.type === 'text' || p.type === 'tool_start'),
  );
  measured.push({
    case: name,
    detectMs: Math.round(sw.at - x.t0),
    resumeMs: next >= 0 ? Math.round((x.times[next] ?? 0) - sw.at) : undefined,
  });
}

const GEMINI = { name: 'primary', label: 'Gemini', model: 'google-gemini/flash' };
const GROQ = { name: 'fallback-1', label: 'Groq', model: 'groq/oss' };
const OLLAMA = {
  name: 'fallback-2',
  label: 'Ollama',
  model: 'ollama/qwen',
  kind: 'local' as const,
};

describe('resilience with the scripted model (blueprint section 8)', () => {
  it('401: hard failure, switches at once with no retry and carries the task over', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p401', [{ error: 401 }]) },
      { ...GROQ, scenario: THREE },
    ]);
    const before = treeHash(w.root);
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('401 invalid key', w);
    expect(errorsOn(w, GEMINI.model)).toBe(1);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini returned 401.']);
    expect(of(w.posts, 'model').at(-1)?.model).toBe('Groq (groq/oss)');
    expect(w.router.active.name).toBe('fallback-1');
    expect(w.router.lastFailure('primary')?.failure.reason).toBe('returned 401');
    expect(w.fake.log).toContain('session.create swage-main-fallback-1 (groq/oss)');
    expect(of(w.posts, 'approval')[0]?.calls[0]?.name).toBe('submit_change_set');
    expect(treeHash(w.root)).toBe(before);
  });

  it('429: retries with backoff (honouring Retry-After), then switches', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p429', [{ error: 429 }]) },
      { ...GROQ, scenario: THREE },
    ]);
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('429 rate limit (2 retries, Retry-After 1 s)', w);
    expect(errorsOn(w, GEMINI.model)).toBe(3); // first try + 2 retries
    expect(
      statusMessages(w).filter((m) =>
        /Gemini returned 429; retrying in 1 s \(retry \d of 2\)/.test(m),
      ),
    ).toHaveLength(2);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini returned 429.']);
  });

  it('500 that recovers on a retry: no switch', async () => {
    const flaky = s('p500once', [{ ...step(2), error: 500, errorTimes: 1 }, step(3), step(5)]);
    w = await world([
      { ...GEMINI, scenario: flaky },
      { ...GROQ, scenario: THREE },
    ]);
    expect(await w.run.start(REQUEST)).toBe('paused');
    expect(errorsOn(w, GEMINI.model)).toBe(1);
    expect(notices(w)).toEqual([]);
    expect(w.router.active.name).toBe('primary');
    expect(w.ctx.tasks.get(w.run.taskId)?.changeSet.stagedPaths()).toHaveLength(3);
  });

  it('500 every time: retries, then switches', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p500', [{ error: 500 }]) },
      { ...GROQ, scenario: THREE },
    ]);
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('500 server error (2 retries)', w);
    expect(errorsOn(w, GEMINI.model)).toBe(3);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini returned 500.']);
  });

  it('a stall: the stall timer abandons the attempt, retries, then switches', async () => {
    const stall: ScenarioStep = {
      text: ['thinking ', 'about ', 'it'],
      stallAfterChunks: 1,
      stallMs: 60_000,
    };
    w = await world(
      [
        {
          ...GEMINI,
          scenario: s('pstall', [stall, stall, stall]),
          timeouts: { ...FAST, stallMs: 300 },
        },
        { ...GROQ, scenario: THREE },
      ],
      1,
    );
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('stall (300 ms stall timer, 1 retry)', w);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini stalled for 300 ms.']);
    expect(w.fake.log.filter((l) => l.startsWith('session.cancel'))).not.toHaveLength(0);
  });

  it('a hang with no first token: the first-token timer fires, then the switch', async () => {
    w = await world(
      [
        {
          ...GEMINI,
          scenario: s('phang', [{ error: 'hang' }]),
          timeouts: { ...FAST, firstTokenMs: 400 },
        },
        { ...GROQ, scenario: THREE },
      ],
      0,
    );
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('hang (400 ms first-token timer, no retry)', w);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini sent nothing in 400 ms.']);
  });

  it('a refused connection: hard, switches at once', async () => {
    w = await world([
      { ...GEMINI, scenario: s('prefused', [{ error: 'refused' }]) },
      { ...GROQ, scenario: THREE },
    ]);
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('connection refused', w);
    expect(errorsOn(w, GEMINI.model)).toBe(1);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini refused the connection.']);
  });

  it('a slow but healthy first token on a local profile does not fall back', async () => {
    const slow = s('pslow', [{ ...step(2), firstTokenDelayMs: 4200 }, step(3), step(5)]);
    w = await world([
      { ...OLLAMA, name: 'primary', scenario: slow, timeouts: { ...FAST, firstTokenMs: 8000 } },
      { ...GROQ, scenario: THREE },
    ]);
    expect(await w.run.start(REQUEST)).toBe('paused');
    expect(notices(w)).toEqual([]);
    expect(w.router.active.name).toBe('primary');
    // The wait is visible, never mistaken for a failure.
    expect(statusMessages(w)).toContain('Waiting for Ollama (3 s)…');
    expect(statusMessages(w)).toContain('Waiting for Ollama (4 s)…');
    expect(w.fake.log.some((l) => l.startsWith('session.create swage-main-fallback-1'))).toBe(
      false,
    );
  }, 20_000);

  it('a fallback in the middle of a task carries the plan and the staged edits over', async () => {
    const [cli, tests, docs] = (step(3).toolCalls ?? []).map((c) => c);
    const primary = s('pmid', [step(2), { toolCalls: [cli as never] }, { error: 500 }]);
    const fallback = s('fmid', [{ toolCalls: [tests as never, docs as never] }, step(5)]);
    w = await world(
      [
        { ...GEMINI, scenario: primary },
        { ...GROQ, scenario: fallback },
      ],
      1,
    );
    expect(await w.run.start(REQUEST)).toBe('paused');
    measure('500 mid-task (after 2 tool steps, 1 retry)', w);
    expect(notices(w)).toEqual(['Switched to Groq because Gemini returned 500.']);
    // The retry on the same profile asked the model to continue, not to start again.
    const primaryInputs = w.fake.inputs.filter((i) => i.sessionId === w?.fake.inputs[0]?.sessionId);
    expect(JSON.stringify(primaryInputs.at(-1)?.input)).toContain(
      'Continue the task from where you stopped',
    );
    // The fallback session started from the task plus the staged diff.
    const carried = w.fake.inputs.find((i) => i.sessionId !== w?.fake.inputs[0]?.sessionId)
      ?.input[0];
    const text = carried?.type === 'user.message' ? String(carried.content) : '';
    expect(text).toContain('This task moved to a different model because Gemini returned 500.');
    expect(text).toContain(REQUEST);
    expect(text).toContain('Plan declared so far:');
    expect(text).toMatch(/Already staged[^\n]*\n- app\/cli\.py: modify, 1 block\(s\), \+13 -0/);
    // Same task, same change set: all three files are staged for one review.
    const staged = w.ctx.tasks.get(w.run.taskId)?.changeSet.stagedPaths().sort();
    expect(staged).toEqual(['app/cli.py', 'docs/cli.md', 'tests/test_cli.py']);
  });

  it('skips a fallback whose model TrueForge does not know, to the next one', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p401b', [{ error: 401 }]) },
      { ...GROQ, scenario: THREE },
      { ...OLLAMA, scenario: THREE },
    ]);
    // Groq's model is missing in TrueForge: creating its agent fails with 422.
    (w.fake as unknown as { opts: { scenarios: Record<string, Scenario> } }).opts.scenarios = {
      [GEMINI.model]: s('p401b', [{ error: 401 }]),
      [OLLAMA.model]: THREE,
    };
    expect(await w.run.start(REQUEST)).toBe('paused');
    expect(notices(w)).toEqual([
      'Switched to Groq because Gemini returned 401.',
      'Switched to Ollama because Groq is not set up in TrueForge.',
    ]);
    expect(w.router.active.name).toBe('fallback-2');
  });

  it('when the last profile also fails: one clear final error naming each failure; workspace unchanged', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p401c', [{ error: 401 }]) },
      { ...GROQ, scenario: s('frefused', [{ error: 'refused' }]) },
    ]);
    const before = treeHash(w.root);
    expect(await w.run.start(REQUEST)).toBe('error');
    expect(of(w.posts, 'status').at(-1)?.message).toBe(
      'All model profiles failed: primary (Gemini) returned 401; fallback-1 (Groq) refused the connection. Nothing was applied; the workspace is unchanged.',
    );
    expect(w.ctx.tasks.get(w.run.taskId)?.cancelled).toBe(true);
    expect(treeHash(w.root)).toBe(before);
  });

  it('a fatal error (our MCP server) does not switch', async () => {
    w = await world([
      { ...GEMINI, scenario: THREE },
      { ...GROQ, scenario: THREE },
    ]);
    // Make the first model request fail the way TrueForge reports an unreachable MCP server.
    const sdk = w.fake.sdk as unknown as { sessions: { createTurnStream: unknown } };
    sdk.sessions.createTurnStream = () =>
      Promise.resolve(
        (async function* () {
          yield {
            type: 'turn.created',
            turnId: 't-x',
            id: 'c',
            createdAt: '',
            threadId: null,
            input: [],
            state: { status: 'running' },
          };
          yield {
            type: 'turn.done',
            id: 'd',
            createdAt: '',
            threadId: null,
            state: {
              status: 'error',
              completedAt: '',
              message: "[MCP Error] Failed to connect to remote MCP server 'editor-tools'",
            },
          };
        })(),
      );
    expect(await w.run.start(REQUEST)).toBe('error');
    expect(notices(w)).toEqual([]);
    expect(of(w.posts, 'status').at(-1)?.message).toMatch(
      /^Gemini could not reach the editor tools/,
    );
  });

  it('TrueForge unreachable when opening the session: fatal, one line, no switch', async () => {
    w = await world([
      { ...GEMINI, scenario: THREE },
      { ...GROQ, scenario: THREE },
    ]);
    (w.fake.sdk as unknown as { sessions: { create: unknown } }).sessions.create = () =>
      Promise.reject(new TypeError('fetch failed'));
    expect(await w.run.start(REQUEST)).toBe('error');
    expect(notices(w)).toEqual([]);
    expect(of(w.posts, 'status').at(-1)?.message).toBe(
      'Gemini could not reach TrueForge or the editor tools: fetch failed',
    );
  });

  it('Stop while the fallback agent is being prepared ends the run cancelled', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p401d', [{ error: 401 }]) },
      { ...GROQ, scenario: THREE },
    ]);
    const sdk = w.fake.sdk as unknown as { agents: { create: (r: unknown) => Promise<unknown> } };
    const create = sdk.agents.create.bind(sdk.agents);
    let release: () => void = () => undefined;
    sdk.agents.create = (r: unknown) =>
      (r as { name: string }).name.includes('fallback')
        ? new Promise((res) => (release = () => void create(r).then(res)))
        : create(r);
    const outcome = w.run.start(REQUEST);
    await waitFor(() => notices(w as World).length === 1, 5000, 'the switch');
    await w.run.cancel();
    release();
    expect(await outcome).toBe('cancelled');
    expect(w.fake.log.some((l) => l.startsWith('session.create swage-main-fallback-1'))).toBe(
      false,
    );
  });

  it('every model rate-limited (a free tier per-minute quota): waits for the first, then finishes the task', async () => {
    // Both answer 429 "try again in 1s" once; waits over 500 ms count as long here.
    w = await world(
      [
        {
          ...GEMINI,
          scenario: s('pq', [{ ...step(2), error: 429, errorTimes: 1 }, step(3), step(5)]),
        },
        {
          ...GROQ,
          scenario: s('fq', [{ ...step(2), error: 429, errorTimes: 1 }, step(3), step(5)]),
        },
      ],
      2,
      { maxRetryWaitMs: 500 },
    );
    expect(await w.run.start(REQUEST)).toBe('paused');
    expect(notices(w)[0]).toBe('Switched to Groq because Gemini returned 429.');
    expect(notices(w)[1]).toMatch(/^Every model is rate-limited; waiting 1 s for (Gemini|Groq)\.$/);
    expect(of(w.posts, 'approval')[0]?.calls[0]?.name).toBe('submit_change_set');
  });

  it('Stop during a backoff wait cancels at once', async () => {
    w = await world([
      { ...GEMINI, scenario: s('p429b', [{ error: 429 }]) },
      { ...GROQ, scenario: THREE },
    ]);
    const outcome = w.run.start(REQUEST);
    await waitFor(
      () => statusMessages(w as World).some((m) => m.includes('retrying in')),
      5000,
      'a retry wait',
    );
    const t0 = performance.now();
    await w.run.cancel();
    expect(await outcome).toBe('cancelled');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(of(w.posts, 'status').at(-1)?.message).toBe(CANCELLED_MESSAGE);
    expect(notices(w)).toEqual([]);
  });
});

describe('switch times', () => {
  it('prints the measured switch times (SWAGE_PRINT_SWITCH=1)', () => {
    if (process.env.SWAGE_PRINT_SWITCH === '1') {
      process.stdout.write(
        '| Failure on the primary | Start to switch | Switch to first event on the fallback |\n| --- | --- | --- |\n',
      );
      for (const m of measured)
        process.stdout.write(`| ${m.case} | ${m.detectMs} ms | ${m.resumeMs ?? '-'} ms |\n`);
    }
    expect(measured.length).toBeGreaterThanOrEqual(0);
  });
});
