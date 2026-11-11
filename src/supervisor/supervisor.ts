import { spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { redactText } from '../safety/redact';
import { OUTBOUND_ALLOWED_HOSTS, TRUEFORGE_VERSION } from './pin';

/**
 * Starts, health-checks, restarts and stops TrueForge as a child process
 * (blueprint sections 4 and 15). Verified against TrueForge 0.184.2:
 * - `npx @truefoundry/trueforge@<v> --port <n>` sets PORT; HOST defaults to `localhost`.
 * - `GET /healthz` returns `{ "status": "ok", "version": "<v>" }`.
 * - SIGTERM and SIGINT trigger a graceful shutdown that closes the database.
 * - `OUTBOUND_URL_ALLOWED_HOSTS` is a JSON string array of exact host names.
 */

export type SupervisorState =
  'stopped' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'failed' | 'external';

export interface ChildLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => ChildLike;

/** Sends a signal to the whole process tree (npx starts a node child). */
export type KillFn = (child: ChildLike, signal: NodeJS.Signals) => void;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(cb: () => void, ms: number): { cancel(): void };
}

export interface SupervisorOptions {
  /** Absolute SQLite path, outside every repository. */
  readonly sqlitePath: string;
  readonly version?: string;
  /** Fixed port; omit to pick a free one. */
  readonly port?: number;
  /** If set and healthy, use this server instead of spawning one (state `external`). */
  readonly reuseUrl?: string;
  readonly host?: string;
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  /** Delays before each restart attempt; the length is the maximum number of restarts. */
  readonly restartBackoffMs?: readonly number[];
  /** A run this long resets the restart counter. */
  readonly stableAfterMs?: number;
  readonly stopTimeoutMs?: number;
  readonly spawn?: SpawnFn;
  readonly kill?: KillFn;
  readonly fetch?: typeof fetch;
  readonly freePort?: () => Promise<number>;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly platform?: NodeJS.Platform;
}

export const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  },
};

/** Asks the OS for a free TCP port on 127.0.0.1. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Kills the process group on POSIX (the child was spawned detached) or the tree on Windows. */
export const killTree: KillFn = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      nodeSpawn('taskkill', [
        '/pid',
        String(child.pid),
        '/T',
        ...(signal === 'SIGKILL' ? ['/F'] : []),
      ]);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
};

const consoleLogger: Logger = {
  info: (m) => console.warn(`[trueforge] ${m}`),
  warn: (m) => console.warn(`[trueforge] ${m}`),
  error: (m) => console.error(`[trueforge] ${m}`),
};

/** Wraps a logger so every line is redacted before it is written. */
export function redactingLogger(inner: Logger): Logger {
  return {
    info: (m) => inner.info(redactText(m)),
    warn: (m) => inner.warn(redactText(m)),
    error: (m) => inner.error(redactText(m)),
  };
}

type Listener = (state: SupervisorState, detail?: string) => void;

export class TrueForgeSupervisor {
  private stateValue: SupervisorState = 'stopped';
  private child: ChildLike | undefined;
  private port: number | undefined;
  private url: string | undefined;
  private restarts = 0;
  private startedAt = 0;
  private pendingRestart: { cancel(): void } | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly opts: Required<Omit<SupervisorOptions, 'port' | 'reuseUrl' | 'platform'>> & {
    port?: number;
    reuseUrl?: string;
    platform: NodeJS.Platform;
  };

  constructor(options: SupervisorOptions) {
    if (!path.isAbsolute(options.sqlitePath)) throw new Error('sqlitePath must be absolute');
    this.opts = {
      version: TRUEFORGE_VERSION,
      host: '127.0.0.1',
      healthTimeoutMs: 120_000,
      healthIntervalMs: 500,
      restartBackoffMs: DEFAULT_RESTART_BACKOFF_MS,
      stableAfterMs: 60_000,
      stopTimeoutMs: 5_000,
      spawn: (cmd, args, o) =>
        nodeSpawn(cmd, [...args], { ...o, stdio: ['ignore', 'pipe', 'pipe'] }),
      kill: killTree,
      fetch: globalThis.fetch.bind(globalThis),
      freePort: () => findFreePort(options.host ?? '127.0.0.1'),
      clock: realClock,
      platform: process.platform,
      ...options,
      logger: redactingLogger(options.logger ?? consoleLogger),
    };
  }

  get state(): SupervisorState {
    return this.stateValue;
  }

  /** Base URL once started, for example `http://127.0.0.1:53121`. */
  get baseUrl(): string | undefined {
    return this.url;
  }

  onStateChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private setState(state: SupervisorState, detail?: string): void {
    this.stateValue = state;
    for (const l of this.listeners) l(state, detail);
  }

  /** Command, arguments and environment used to start TrueForge (secrets never pass through here). */
  launchSpec(port: number): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } {
    return {
      command: this.opts.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', `@truefoundry/trueforge@${this.opts.version}`, '--port', String(port)],
      cwd: path.dirname(this.opts.sqlitePath),
      env: {
        ...process.env,
        SQLITE_PATH: this.opts.sqlitePath,
        OUTBOUND_URL_ALLOWED_HOSTS: JSON.stringify(OUTBOUND_ALLOWED_HOSTS),
        HOST: this.opts.host,
        PORT: String(port),
      },
    };
  }

  /** Returns the server version if `/healthz` answers ok. */
  async health(url = this.url): Promise<string | undefined> {
    if (url === undefined) return undefined;
    try {
      const res = await this.opts.fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { status?: string; version?: string };
      return body.status === 'ok' ? (body.version ?? 'unknown') : undefined;
    } catch {
      return undefined;
    }
  }

  /** Starts TrueForge (or reuses a healthy external one) and resolves with its base URL. */
  async start(): Promise<string> {
    if (this.stateValue === 'ready' || this.stateValue === 'external') return this.url ?? '';
    if (this.opts.reuseUrl !== undefined) {
      const version = await this.health(this.opts.reuseUrl);
      if (version !== undefined) {
        this.url = this.opts.reuseUrl;
        if (version !== this.opts.version) {
          this.opts.logger.warn(
            `Using the running TrueForge ${version}; Swage is pinned to ${this.opts.version}.`,
          );
        }
        this.setState('external', version);
        return this.url;
      }
    }
    this.restarts = 0;
    await this.launch('starting');
    return this.url ?? '';
  }

  private async launch(state: 'starting' | 'restarting'): Promise<void> {
    this.setState(state);
    this.port ??= this.opts.port ?? (await this.opts.freePort());
    const spec = this.launchSpec(this.port);
    this.url = `http://${this.opts.host}:${this.port}`;
    this.opts.logger.info(`Starting TrueForge ${this.opts.version} on ${this.url}`);

    const child = this.opts.spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: this.opts.platform !== 'win32',
    });
    this.child = child;
    this.startedAt = this.opts.clock.now();
    const pipe = (chunk: Buffer | string, level: 'info' | 'warn'): void => {
      for (const line of String(chunk).split(/\r?\n/))
        if (line.trim() !== '') this.opts.logger[level](line);
    };
    child.stdout?.on('data', (c) => pipe(c, 'info'));
    child.stderr?.on('data', (c) => pipe(c, 'warn'));
    child.on('error', (err) => this.opts.logger.error(`Could not start TrueForge: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));

    const deadline = this.opts.clock.now() + this.opts.healthTimeoutMs;
    while (this.opts.clock.now() < deadline) {
      if (this.child !== child || child.exitCode !== null) {
        if (state === 'starting') this.setState('failed', 'exited during start');
        throw new Error(
          'TrueForge exited before it became healthy. See the TrueForge log for details.',
        );
      }
      const version = await this.health();
      if (version !== undefined) {
        this.setState('ready', version);
        this.opts.logger.info(`TrueForge ${version} is ready at ${this.url}`);
        return;
      }
      await this.opts.clock.sleep(this.opts.healthIntervalMs);
    }
    this.setState('failed', 'health timeout');
    this.opts.kill(child, 'SIGKILL');
    throw new Error(
      `TrueForge did not become healthy within ${Math.round(this.opts.healthTimeoutMs / 1000)} s.`,
    );
  }

  private onExit(child: ChildLike, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.child = undefined;
    // During the first start the health loop reports the failure; a failed or deliberate stop never restarts.
    if (['stopping', 'stopped', 'starting', 'failed'].includes(this.stateValue)) return;
    this.opts.logger.warn(
      `TrueForge exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`,
    );

    if (this.opts.clock.now() - this.startedAt >= this.opts.stableAfterMs) this.restarts = 0;
    const delay = this.opts.restartBackoffMs[this.restarts];
    if (delay === undefined) {
      this.setState('failed', `exited ${this.restarts + 1} times`);
      this.opts.logger.error('TrueForge keeps crashing; giving up. Run Swage: Doctor for details.');
      return;
    }
    this.restarts++;
    this.setState('restarting', `attempt ${this.restarts} in ${delay} ms`);
    this.pendingRestart = this.opts.clock.setTimeout(() => {
      this.pendingRestart = undefined;
      this.launch('restarting').catch((err: unknown) => {
        this.opts.logger.error((err as Error).message);
      });
    }, delay);
  }

  /** Stops TrueForge: SIGTERM, then SIGKILL after the stop timeout. An external server is left running. */
  async stop(): Promise<void> {
    this.pendingRestart?.cancel();
    this.pendingRestart = undefined;
    if (this.stateValue === 'external') {
      this.setState('stopped');
      return;
    }
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      this.setState('stopped');
      return;
    }
    this.setState('stopping');
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    this.opts.kill(child, 'SIGTERM');
    const timedOut = await Promise.race([
      exited.then(() => false),
      this.opts.clock.sleep(this.opts.stopTimeoutMs).then(() => true),
    ]);
    if (timedOut) {
      this.opts.logger.warn('TrueForge did not stop in time; killing it.');
      this.opts.kill(child, 'SIGKILL');
      await exited;
    }
    this.child = undefined;
    this.setState('stopped');
  }
}

/** Anything with an async stop, such as Swage's MCP server. */
export interface Stoppable {
  stop(): Promise<void>;
}

/**
 * Shutdown order matters: a registered MCP server that disappears while TrueForge is
 * running can crash TrueForge (upstream issue 878, still open on 11 November 2026).
 * So TrueForge stops first, then the MCP server.
 */
export async function shutdownInOrder(
  trueforge: Stoppable,
  mcpServer: Stoppable | undefined,
): Promise<void> {
  try {
    await trueforge.stop();
  } finally {
    await mcpServer?.stop();
  }
}
