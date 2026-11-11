import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  findFreePort,
  redactingLogger,
  shutdownInOrder,
  TrueForgeSupervisor,
  type ChildLike,
  type Clock,
  type Logger,
  type SupervisorOptions,
  type SupervisorState,
} from '../../../src/supervisor/supervisor';

class FakeChild extends EventEmitter implements ChildLike {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  exitCode: number | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code ?? 1;
    this.emit('exit', code, signal);
  }
}

class FakeClock implements Clock {
  t = 0;
  timers: { at: number; cb: () => void; cancelled: boolean }[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    await Promise.resolve();
  }
  setTimeout(cb: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.t + ms, cb, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }
  /** Runs every due timer after advancing to the latest one. */
  runTimers(): number[] {
    const delays: number[] = [];
    for (const timer of this.timers.splice(0)) {
      if (timer.cancelled) continue;
      delays.push(timer.at - this.t);
      this.t = Math.max(this.t, timer.at);
      timer.cb();
    }
    return delays;
  }
}

function harness(overrides: Partial<SupervisorOptions> = {}) {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const spawned: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
  }[] = [];
  const kills: [number, NodeJS.Signals][] = [];
  const logs: string[] = [];
  let healthy = true;
  let version = '0.184.2';
  let healthCalls = 0;
  let unhealthyCalls = 0;
  let onHealthCall: ((n: number) => void) | undefined;
  const logger: Logger = {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  };
  const fetchFn = ((url: string) => {
    healthCalls++;
    onHealthCall?.(healthCalls);
    if (!healthy || unhealthyCalls > 0) {
      unhealthyCalls = Math.max(0, unhealthyCalls - 1);
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version, url }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  const sup = new TrueForgeSupervisor({
    sqlitePath: '/Users/me/trueforge-data/trueforge.sqlite',
    clock,
    logger,
    fetch: fetchFn,
    freePort: () => Promise.resolve(53121),
    platform: 'darwin',
    healthIntervalMs: 500,
    healthTimeoutMs: 5000,
    spawn: (command, args, o) => {
      spawned.push({ command, args, ...o });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    kill: (child, signal) => {
      kills.push([child.pid ?? -1, signal]);
      if (signal === 'SIGTERM' && (child as FakeChild).listenerCount('exit') > 0 && termExits) {
        queueMicrotask(() => (child as FakeChild).exit(null, 'SIGTERM'));
      }
      if (signal === 'SIGKILL') queueMicrotask(() => (child as FakeChild).exit(null, 'SIGKILL'));
    },
    ...overrides,
  });
  const states: string[] = [];
  sup.onStateChange((s: SupervisorState, d?: string) => states.push(d ? `${s}(${d})` : s));
  let termExits = true;
  return {
    sup,
    clock,
    children,
    spawned,
    kills,
    logs,
    states,
    setHealthy: (h: boolean) => (healthy = h),
    failNextHealthChecks: (n: number) => (unhealthyCalls = n),
    onHealthCall: (fn: (n: number) => void) => (onHealthCall = fn),
    setVersion: (v: string) => (version = v),
    healthCalls: () => healthCalls,
    ignoreSigterm: () => (termExits = false),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TrueForgeSupervisor.start', () => {
  it('spawns the pinned npx command on a free port with SQLite outside the repo and loopback allowlisted', async () => {
    const h = harness();
    const url = await h.sup.start();
    expect(url).toBe('http://127.0.0.1:53121');
    expect(h.sup.state).toBe('ready');
    const [s] = h.spawned;
    expect(s?.command).toBe('npx');
    expect(s?.args).toEqual(['--yes', '@truefoundry/trueforge@0.184.2', '--port', '53121']);
    expect(s?.cwd).toBe('/Users/me/trueforge-data');
    expect(s?.detached).toBe(true);
    expect(s?.env).toMatchObject({
      SQLITE_PATH: '/Users/me/trueforge-data/trueforge.sqlite',
      OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1","localhost"]',
      HOST: '127.0.0.1',
      PORT: '53121',
    });
    expect(h.states).toEqual(['starting', 'ready(0.184.2)']);
    expect(await h.sup.start()).toBe(url);
    expect(h.spawned).toHaveLength(1);
  });

  it('uses npx.cmd and no process group on Windows, and a fixed port when given', () => {
    const h = harness({ platform: 'win32', port: 8790 });
    expect(h.sup.launchSpec(8790).command).toBe('npx.cmd');
  });

  it('waits for /healthz before reporting ready', async () => {
    const h = harness();
    h.failNextHealthChecks(3);
    await h.sup.start();
    expect(h.sup.state).toBe('ready');
    expect(h.healthCalls()).toBe(4);
    expect(h.clock.t).toBe(1500);
  });

  it('fails and kills the child when health never comes, without restarting', async () => {
    const h = harness();
    h.setHealthy(false);
    await expect(h.sup.start()).rejects.toThrow(/did not become healthy within 5 s/);
    await flush();
    expect(h.sup.state).toBe('failed');
    expect(h.kills.at(-1)?.[1]).toBe('SIGKILL');
    expect(h.clock.runTimers()).toEqual([]);
    expect(h.spawned).toHaveLength(1);
  });

  it('fails fast when the child exits before it is healthy, without restarting', async () => {
    const h = harness();
    h.setHealthy(false);
    h.onHealthCall((n) => {
      if (n === 2) h.children[0]?.exit(1);
    });
    await expect(h.sup.start()).rejects.toThrow(/exited before it became healthy/);
    expect(h.sup.state).toBe('failed');
    expect(h.clock.runTimers()).toEqual([]);
  });

  it('reuses a healthy running server instead of spawning, and leaves it running on stop', async () => {
    const h = harness({ reuseUrl: 'http://localhost:8790' });
    h.setVersion('0.183.0');
    expect(await h.sup.start()).toBe('http://localhost:8790');
    expect(h.sup.state).toBe('external');
    expect(h.spawned).toHaveLength(0);
    expect(
      h.logs.some((l) =>
        /Using the running TrueForge 0\.183\.0; Swage is pinned to 0\.184\.2/.test(l),
      ),
    ).toBe(true);
    await h.sup.stop();
    expect(h.kills).toEqual([]);
    expect(h.sup.state).toBe('stopped');
  });

  it('spawns its own server when the reuse URL is not healthy', async () => {
    const h = harness({ reuseUrl: 'http://localhost:8790' });
    h.failNextHealthChecks(1);
    await h.sup.start();
    expect(h.spawned).toHaveLength(1);
    expect(h.sup.state).toBe('ready');
    expect(h.sup.baseUrl).toBe('http://127.0.0.1:53121');
  });

  it('rejects a relative SQLite path', () => {
    expect(() => new TrueForgeSupervisor({ sqlitePath: 'db.sqlite' })).toThrow(/absolute/);
  });
});

describe('crash restart with backoff', () => {
  it('restarts on the same port after a crash, backing off 1, 2, 4, 8, 16 s, then gives up', async () => {
    const h = harness();
    await h.sup.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.children.at(-1)?.exit(1);
      delays.push(...h.clock.runTimers());
      await flush();
      expect(h.sup.state).toBe('ready');
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(new Set(h.spawned.map((s) => s.args.at(-1)))).toEqual(new Set(['53121']));
    h.children.at(-1)?.exit(1);
    expect(h.sup.state).toBe('failed');
    expect(h.logs.some((l) => l.includes('keeps crashing'))).toBe(true);
  });

  it('resets the restart counter after a stable run', async () => {
    const h = harness({ restartBackoffMs: [1000], stableAfterMs: 60_000 });
    await h.sup.start();
    h.children.at(-1)?.exit(1);
    h.clock.runTimers();
    await flush();
    h.clock.t += 61_000;
    h.children.at(-1)?.exit(1);
    expect(h.sup.state).toBe('restarting');
  });

  it('does not restart after a deliberate stop, and cancels a pending restart', async () => {
    const h = harness();
    await h.sup.start();
    h.children.at(-1)?.exit(1);
    expect(h.sup.state).toBe('restarting');
    await h.sup.stop();
    expect(h.clock.runTimers()).toEqual([]);
    expect(h.spawned).toHaveLength(1);
    expect(h.sup.state).toBe('stopped');
  });
});

describe('stop', () => {
  it('sends SIGTERM to the process tree and waits for exit', async () => {
    const h = harness();
    await h.sup.start();
    await h.sup.stop();
    expect(h.kills).toEqual([[h.children[0]?.pid, 'SIGTERM']]);
    expect(h.states.slice(-2)).toEqual(['stopping', 'stopped']);
  });

  it('escalates to SIGKILL when TrueForge ignores SIGTERM', async () => {
    const h = harness({ stopTimeoutMs: 3000 });
    await h.sup.start();
    h.ignoreSigterm();
    await h.sup.stop();
    expect(h.kills.map((k) => k[1])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.logs.some((l) => l.includes('did not stop in time'))).toBe(true);
  });

  it('is a no-op when nothing runs', async () => {
    const h = harness();
    await h.sup.stop();
    expect(h.sup.state).toBe('stopped');
  });
});

describe('logging', () => {
  it('forwards child output line by line with secrets redacted', async () => {
    const h = harness();
    await h.sup.start();
    const key = 'gs' + 'k_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    h.children[0]?.stdout.emit('data', Buffer.from(`listening\nusing key ${key}\n`));
    h.children[0]?.stderr.emit('data', 'warn line\r\n');
    expect(h.logs).toContain('info listening');
    expect(h.logs.some((l) => l.includes(key))).toBe(false);
    expect(h.logs.some((l) => l.includes('[REDACTED:groq_key]'))).toBe(true);
    expect(h.logs).toContain('warn warn line');
    h.children[0]?.emit('error', new Error('spawn npx ENOENT'));
    expect(h.logs).toContain('error Could not start TrueForge: spawn npx ENOENT');
  });

  it('redactingLogger redacts every level', () => {
    const out: string[] = [];
    const log = redactingLogger({
      info: (m) => out.push(m),
      warn: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    const pw = 'hunter' + '2-real';
    log.info(`password = "${pw}"`);
    log.warn(`password = "${pw}"`);
    log.error(`password = "${pw}"`);
    expect(out.every((l) => !l.includes(pw))).toBe(true);
  });
});

describe('shutdownInOrder', () => {
  it('stops TrueForge before the MCP server, even if TrueForge fails to stop', async () => {
    const order: string[] = [];
    await shutdownInOrder(
      { stop: () => (order.push('trueforge'), Promise.resolve()) },
      { stop: () => (order.push('mcp'), Promise.resolve()) },
    );
    expect(order).toEqual(['trueforge', 'mcp']);

    const order2: string[] = [];
    await expect(
      shutdownInOrder(
        { stop: () => (order2.push('trueforge'), Promise.reject(new Error('boom'))) },
        { stop: () => (order2.push('mcp'), Promise.resolve()) },
      ),
    ).rejects.toThrow('boom');
    expect(order2).toEqual(['trueforge', 'mcp']);
    await shutdownInOrder({ stop: () => Promise.resolve() }, undefined);
  });
});

describe('findFreePort', () => {
  it('returns a usable port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
