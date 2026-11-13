import { describe, expect, it } from 'vitest';
import { carryOverMessage } from '../../../src/resilience/carryOver';
import type { Failure } from '../../../src/resilience/classify';
import {
  allFailedMessage,
  ModelRouter,
  RecoveryMonitor,
  switchMessage,
} from '../../../src/resilience/fallback';
import { resolveProfiles } from '../../../src/resilience/profiles';
import { Watchdog, type Clock } from '../../../src/resilience/watchdog';

/** A manual clock: timers fire only when the test advances time. */
class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.timers.size;
  }
}

const T = { connectMs: 1000, firstTokenMs: 5000, stallMs: 2000, totalMs: 60_000 };
const profiles = resolveProfiles([
  { name: 'primary', label: 'Gemini', trueforgeModel: 'g/flash' },
  { name: 'fallback-1', label: 'Groq', trueforgeModel: 'groq/x' },
  { name: 'fallback-2', label: 'Ollama', kind: 'local', trueforgeModel: 'ollama/y' },
]);
const hard: Failure = { kind: 'hard', reason: 'returned 401', detail: 'x', status: 401 };
const transient: Failure = { kind: 'transient', reason: 'returned 429', detail: 'x', status: 429 };
const fatal: Failure = {
  kind: 'fatal',
  reason: 'could not reach the editor tools',
  detail: '[MCP Error] x',
};

describe('watchdog', () => {
  function dog(onWaiting?: (s: number) => void) {
    const clock = new FakeClock();
    const fired: string[] = [];
    const w = new Watchdog({
      timeouts: T,
      clock,
      onTimeout: (f) => fired.push(f.reason),
      ...(onWaiting ? { onWaiting } : {}),
    });
    return { clock, fired, w };
  }

  it('connect timer: TrueForge never starts the turn', () => {
    const { clock, fired, w } = dog();
    w.start();
    clock.advance(999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['did not connect in 1 s']);
    expect(clock.pending).toBe(0);
  });

  it('first-token timer, with a once-a-second waiting tick after 3 s', () => {
    const ticks: number[] = [];
    const { clock, fired, w } = dog((s) => ticks.push(s));
    w.start();
    w.connected();
    clock.advance(4999);
    expect(fired).toEqual([]);
    expect(ticks).toEqual([3, 4]);
    clock.advance(1);
    expect(fired).toEqual(['sent nothing in 5 s']);
  });

  it('a slow first token within the limit is fine; the stall timer then guards silence', () => {
    const { clock, fired, w } = dog();
    w.start();
    w.connected();
    clock.advance(4500);
    w.activity();
    clock.advance(1999);
    w.activity(); // still streaming
    clock.advance(1999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['stalled for 2 s']);
  });

  it('tool executions pause the stall timer', () => {
    const { clock, fired, w } = dog();
    w.start();
    w.activity();
    w.toolStarted('a');
    clock.advance(30_000); // a long test run
    expect(fired).toEqual([]);
    w.toolEnded('a');
    clock.advance(2000);
    expect(fired).toEqual(['stalled for 2 s']);
  });

  it('total ceiling, and stop() clears every timer', () => {
    const { clock, fired, w } = dog();
    w.start();
    w.activity();
    for (let i = 0; i < 40; i++) {
      clock.advance(1500);
      w.activity();
    }
    expect(fired).toEqual(['ran past its 60 s limit']);
    const second = dog();
    second.w.start();
    second.w.connected();
    second.w.stop();
    expect(second.clock.pending).toBe(0);
    second.w.activity();
    second.clock.advance(100_000);
    expect(second.fired).toEqual([]);
  });

  it('activity before connected counts as connected; events after stop are ignored', () => {
    const { clock, fired, w } = dog();
    w.activity(); // idle: ignored
    w.start();
    w.activity();
    expect(w.state).toBe('streaming');
    clock.advance(1999);
    expect(fired).toEqual([]);
  });
});

describe('watchdog edge cases', () => {
  it('ignores repeated connects, ends tools outside streaming, and ticks stop once output starts', () => {
    const clock = new FakeClock();
    const ticks: number[] = [];
    const fired: string[] = [];
    const w = new Watchdog({
      timeouts: T,
      clock,
      waitingAfterMs: 500,
      onWaiting: (s) => ticks.push(s),
      onTimeout: (f) => fired.push(f.reason),
    });
    w.toolEnded('x'); // idle: nothing to do
    w.start();
    w.connected();
    w.connected(); // ignored
    clock.advance(1600);
    expect(ticks).toEqual([1, 2]);
    w.toolStarted('t');
    clock.advance(10_000);
    expect(ticks).toEqual([1, 2]);
    w.stop();
    w.toolEnded('t');
    clock.advance(100_000);
    expect(fired).toEqual([]);
  });
});

describe('router and fallback plan', () => {
  it('hard: switch at once; transient: retry with backoff, then switch; fatal: stop', () => {
    const router = new ModelRouter(profiles, { retries: 2, backoff: { baseMs: 1000, jitter: 0 } });
    const plan = router.begin();
    expect(plan.decide(transient)).toEqual({ action: 'retry', delayMs: 1000, retry: 1, of: 2 });
    expect(plan.decide(transient)).toEqual({ action: 'retry', delayMs: 2000, retry: 2, of: 2 });
    const sw = plan.decide(transient);
    expect(sw).toMatchObject({
      action: 'switch',
      message: 'Switched to Groq because Gemini returned 429.',
    });
    expect(router.active.name).toBe('fallback-1');
    expect(plan.decide(hard)).toMatchObject({
      action: 'switch',
      message: 'Switched to Ollama because Groq returned 401.',
    });
    expect(plan.decide(fatal)).toEqual({
      action: 'fail',
      message: 'Ollama could not reach the editor tools: [MCP Error] x',
    });
    expect(plan.decide(hard)).toEqual({
      action: 'fail',
      message:
        'All model profiles failed: primary (Gemini) returned 429; fallback-1 (Groq) returned 401; fallback-2 (Ollama) returned 401. Nothing was applied; the workspace is unchanged.',
    });
    expect(plan.failures).toHaveLength(3);
  });

  it('timeouts retry once by default, other transient failures three times', () => {
    const router = new ModelRouter(profiles, { backoff: { baseMs: 1000, jitter: 0 } });
    const stall: Failure = {
      kind: 'transient',
      reason: 'stalled for 30 s',
      detail: 'x',
      timeout: true,
    };
    const plan = router.begin();
    expect(plan.decide(stall)).toEqual({ action: 'retry', delayMs: 1000, retry: 1, of: 1 });
    expect(plan.decide(stall)).toMatchObject({
      action: 'switch',
      message: 'Switched to Groq because Gemini stalled for 30 s.',
    });
    expect(plan.decide(transient)).toMatchObject({ action: 'retry', retry: 1, of: 3 });
    expect(plan.decide(transient)).toMatchObject({ action: 'retry', retry: 2, of: 3 });
    expect(plan.decide(transient)).toMatchObject({ action: 'retry', retry: 3, of: 3 });
    expect(plan.decide(transient)).toMatchObject({ action: 'switch', to: { name: 'fallback-2' } });
    expect(new ModelRouter(profiles, { retries: 0, timeoutRetries: 2 }).timeoutRetries).toBe(0);
  });

  it('a long server-requested wait moves on to an untried profile instead of waiting', () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles, { clock, backoff: { baseMs: 1000, jitter: 0 } });
    const quota: Failure = { ...transient, retryAfterMs: 23_756 };
    const plan = router.begin();
    expect(plan.decide(quota)).toMatchObject({ action: 'switch', to: { name: 'fallback-1' } });
    expect(plan.decide({ ...transient, retryAfterMs: 5000 })).toMatchObject({
      action: 'retry',
      delayMs: 5000,
    });
    expect(plan.decide(quota)).toMatchObject({ action: 'switch', to: { name: 'fallback-2' } });
  });

  it('every profile rate-limited: waits for the first to come back, then uses it again (free-tier quotas)', () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles.slice(0, 2), { clock });
    const plan = router.begin();
    // Gemini: retry in 30 s; Groq: retry in 13 s. Groq comes back first.
    expect(plan.decide({ ...transient, retryAfterMs: 30_000 })).toMatchObject({
      action: 'switch',
      to: { name: 'fallback-1' },
    });
    clock.advance(2000);
    expect(plan.decide({ ...transient, retryAfterMs: 13_000 })).toMatchObject({
      action: 'switch',
      to: { name: 'fallback-1' },
      delayMs: 13_000,
      message: 'Every model is rate-limited; waiting 13 s for Groq.',
    });
    // Later, Gemini's minute is over: a new limit on Groq moves the task back to Gemini at once.
    clock.advance(40_000);
    expect(plan.decide({ ...transient, retryAfterMs: 20_000 })).toMatchObject({
      action: 'switch',
      to: { name: 'primary' },
      message: 'Switched to Gemini because Groq returned 429.',
    });
    expect(plan.decide({ ...transient, retryAfterMs: 20_000 }).action).toBe('switch');
  });

  it('stops handing the task back and forth after maxSwitches', () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles.slice(0, 2), { clock, maxSwitches: 3 });
    const plan = router.begin();
    const actions: string[] = [];
    for (let i = 0; i < 5; i++) {
      actions.push(plan.decide({ ...transient, retryAfterMs: 15_000 }).action);
      clock.advance(20_000); // each limit is over by the time the other model fails
    }
    expect(actions).toEqual(['switch', 'switch', 'switch', 'fail', 'fail']);
    expect(plan.decide(hard)).toMatchObject({
      action: 'fail',
      message: expect.stringMatching(
        /^Gave up after 3 model switches: every model kept failing, last Groq returned 401\./,
      ),
    });
  });

  it('gives up with one clear line once the total wait would pass the cap, or a profile failed for good', () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles.slice(0, 2), { clock, maxQuotaWaitMs: 60_000 });
    const plan = router.begin();
    expect(plan.decide({ ...transient, retryAfterMs: 50_000 }).action).toBe('switch');
    expect(plan.decide({ ...transient, retryAfterMs: 50_000 })).toMatchObject({
      action: 'switch',
      delayMs: 50_000,
    });
    expect(plan.decide({ ...transient, retryAfterMs: 50_000 })).toMatchObject({ action: 'fail' });
    const hardPlan = new ModelRouter(profiles.slice(0, 2), { clock }).begin();
    expect(hardPlan.decide(hard).action).toBe('switch');
    expect(hardPlan.decide(hard)).toMatchObject({ action: 'fail' });
  });

  it('new tasks go back to a profile whose rate limit is over, but not past a hard failure', () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles, { clock });
    router.begin().decide({ ...transient, retryAfterMs: 20_000 }); // Gemini rate-limited -> Groq
    expect(router.active.name).toBe('fallback-1');
    expect(router.begin().current.name).toBe('fallback-1'); // still inside the limit
    clock.advance(20_000);
    expect(router.begin().current.name).toBe('primary'); // the minute is over: back to Gemini
    router.begin().decide(hard); // Gemini 401 -> Groq
    clock.advance(600_000);
    expect(router.begin().current.name).toBe('fallback-1'); // a hard failure is not retried
  });

  it('starts later tasks on the active profile and wraps to earlier ones', () => {
    const router = new ModelRouter(profiles);
    router.setActive('fallback-1');
    const plan = router.begin();
    expect(plan.current.name).toBe('fallback-1');
    expect(plan.decide(hard)).toMatchObject({ action: 'switch', to: { name: 'fallback-2' } });
    expect(plan.decide(hard)).toMatchObject({ action: 'switch', to: { name: 'primary' } });
  });

  it('tracks failures, health, profile changes and the active profile; notifies listeners', () => {
    const router = new ModelRouter(profiles);
    let changes = 0;
    const sub = router.onDidChange(() => changes++);
    router.recordFailure(router.primary, hard);
    router.setActive('fallback-1');
    expect(router.failedAbove().map((p) => p.name)).toEqual(['primary']);
    router.recordHealthy(router.primary);
    expect(router.failedAbove()).toEqual([]);
    expect(router.setActive('nope')).toBe(false);
    router.setProfiles(resolveProfiles([{ name: 'other', trueforgeModel: 'a/b' }]));
    expect(router.active.name).toBe('other');
    router.setProfiles([]);
    expect(router.active.name).toBe('other');
    sub.dispose();
    const before = changes;
    router.setActive('other');
    expect(changes).toBe(before);
    expect(() => new ModelRouter([])).toThrow();
    const plan = new ModelRouter(profiles).begin();
    plan.succeeded();
    expect(plan.current.name).toBe('primary');
  });

  it('forgets failures of removed profiles and has no next profile when alone', () => {
    const router = new ModelRouter(profiles);
    router.recordFailure(router.primary, hard);
    router.setProfiles(profiles.slice(1));
    expect(router.lastFailure('primary')).toBeUndefined();
    const solo = new ModelRouter(profiles.slice(0, 1));
    expect(solo.next(solo.primary, new Set())).toBeUndefined();
    expect(solo.begin().decide(hard)).toMatchObject({ action: 'fail' });
  });

  it('formats the banner and the final error from labels only', () => {
    const [a, b] = profiles;
    if (!a || !b) throw new Error('profiles');
    expect(switchMessage(a, b, transient)).toBe('Switched to Groq because Gemini returned 429.');
    expect(allFailedMessage([[a, hard]])).toMatch(
      /^All model profiles failed: primary \(Gemini\) returned 401\./,
    );
  });
});

describe('recovery monitor', () => {
  it('probes failed profiles ahead of the active one and offers each recovery once', async () => {
    const clock = new FakeClock();
    const router = new ModelRouter(profiles, { clock });
    let healthy = false;
    const probed: string[] = [];
    const monitor = new RecoveryMonitor({
      router,
      clock,
      intervalMs: 60_000,
      probe: (p) => {
        probed.push(p.name);
        return Promise.resolve(healthy);
      },
    });
    const recovered: string[] = [];
    monitor.onRecovered((p) => recovered.push(p.name));
    router.begin().decide(hard); // primary fails, Groq takes over
    expect(router.active.name).toBe('fallback-1');
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0)); // let the timer's check finish
    expect(probed).toEqual(['primary']);
    expect(recovered).toEqual([]);
    healthy = true;
    expect((await monitor.check()).map((p) => p.name)).toEqual(['primary']);
    expect(recovered).toEqual(['primary']);
    expect(router.active.name).toBe('fallback-1'); // never switches back by itself
    expect(await monitor.check()).toEqual([]);
    monitor.dispose();
  });

  it('gives up after maxProbes and treats a throwing probe as down', async () => {
    const router = new ModelRouter(profiles);
    router.recordFailure(router.primary, hard);
    router.setActive('fallback-1');
    const monitor = new RecoveryMonitor({
      router,
      maxProbes: 2,
      intervalMs: 1e9,
      probe: () => Promise.reject(new Error('down')),
    });
    expect(await monitor.check()).toEqual([]);
    expect(await monitor.check()).toEqual([]);
    expect(await monitor.check()).toEqual([]);
    monitor.dispose();
  });
});

describe('carry-over message', () => {
  it('states why, repeats the task, and lists the plan, files and staged edits', () => {
    const text = carryOverMessage({
      original: 'Request:\nAdd a config command',
      why: 'Gemini returned 429',
      plan: ['Add the command', 'Test it'],
      files: [{ path: 'app/cli.py', reason: 'commands live here' }],
      staged: [
        {
          path: 'app/cli.py',
          kind: 'modify',
          blocks: [
            {
              id: 'b1',
              oldStart: 0,
              oldLines: ['a\n'],
              newStart: 0,
              newLines: ['b\n', 'c\n'],
              whitespaceOnly: false,
              state: 'pending',
            },
          ],
        },
        { path: 'empty.py', kind: 'modify', blocks: [] },
      ],
    });
    expect(text).toContain('because Gemini returned 429. The workspace has not changed');
    expect(text).toContain('Request:\nAdd a config command');
    expect(text).toContain('1. Add the command\n2. Test it');
    expect(text).toContain('- app/cli.py: commands live here');
    expect(text).toContain('- app/cli.py: modify, 1 block(s), +2 -1');
    expect(text).not.toContain('empty.py: modify');
  });

  it('says to start over when nothing was done', () => {
    expect(
      carryOverMessage({ original: 'x', why: 'y', plan: [], files: [], staged: [] }),
    ).toContain('Nothing was staged before the switch; start the task from the beginning.');
  });
});
