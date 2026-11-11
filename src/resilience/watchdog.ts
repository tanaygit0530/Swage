import type { ProfileTimeouts } from '../client/manifest';
import { timeoutFailure, type Failure } from './classify';

/**
 * Layered timers for one model attempt (blueprint section 8): connect until TrueForge starts
 * the turn, first token until the model's first event, stall while output is flowing, and a
 * total ceiling. Tool executions pause the stall timer: a two-minute test run is not a stalled
 * model. While waiting for the first token it ticks once a second so the UI can say
 * "Waiting for model (14 s)" instead of looking frozen.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WatchdogOptions {
  readonly timeouts: ProfileTimeouts;
  /** Called once, when a timer expires. The attempt should be abandoned. */
  readonly onTimeout: (failure: Failure) => void;
  /** Seconds spent waiting for the first token, after `waitingAfterMs`, once a second. */
  readonly onWaiting?: (seconds: number) => void;
  readonly waitingAfterMs?: number;
  readonly clock?: Clock;
}

type Timer = 'connect' | 'firstToken' | 'stall' | 'total' | 'tick';

export class Watchdog {
  private readonly clock: Clock;
  private readonly handles = new Map<Timer, unknown>();
  private readonly tools = new Set<string>();
  private phase: 'idle' | 'connecting' | 'waiting' | 'streaming' | 'done' = 'idle';
  private waitStart = 0;

  constructor(private readonly opts: WatchdogOptions) {
    this.clock = opts.clock ?? realClock;
  }

  get state(): string {
    return this.phase;
  }

  private set(timer: Timer, ms: number, fn: () => void): void {
    this.clear(timer);
    this.handles.set(timer, this.clock.setTimeout(fn, ms));
  }

  private clear(timer: Timer): void {
    const h = this.handles.get(timer);
    if (h !== undefined) this.clock.clearTimeout(h);
    this.handles.delete(timer);
  }

  private expire(which: Exclude<Timer, 'tick'>, ms: number): void {
    if (this.phase === 'done') return;
    this.stop();
    this.opts.onTimeout(timeoutFailure(which, ms));
  }

  /** The attempt begins: the request to TrueForge is about to be sent. */
  start(): void {
    const t = this.opts.timeouts;
    this.phase = 'connecting';
    this.set('connect', t.connectMs, () => this.expire('connect', t.connectMs));
    this.set('total', t.totalMs, () => this.expire('total', t.totalMs));
  }

  /** TrueForge started the turn; the model has not answered yet. */
  connected(): void {
    if (this.phase !== 'connecting') return;
    const t = this.opts.timeouts;
    this.clear('connect');
    this.phase = 'waiting';
    this.waitStart = this.clock.now();
    this.set('firstToken', t.firstTokenMs, () => this.expire('firstToken', t.firstTokenMs));
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.opts.onWaiting) return;
    const after = this.opts.waitingAfterMs ?? 3000;
    const elapsed = this.clock.now() - this.waitStart;
    const next = elapsed < after ? after - elapsed : 1000 - ((elapsed - after) % 1000);
    this.set('tick', Math.max(1, next), () => {
      if (this.phase !== 'waiting') return;
      this.opts.onWaiting?.(Math.round((this.clock.now() - this.waitStart) / 1000));
      this.scheduleTick();
    });
  }

  /** Any model event (text, a tool call). */
  activity(): void {
    if (this.phase === 'done' || this.phase === 'idle') return;
    if (this.phase === 'connecting') this.connected();
    this.clear('firstToken');
    this.clear('tick');
    this.phase = 'streaming';
    this.armStall();
  }

  private armStall(): void {
    if (this.tools.size > 0) {
      this.clear('stall');
      return;
    }
    const ms = this.opts.timeouts.stallMs;
    this.set('stall', ms, () => this.expire('stall', ms));
  }

  /** A tool started executing; the model is not expected to speak until it returns. */
  toolStarted(id: string): void {
    this.activity();
    this.tools.add(id);
    this.clear('stall');
  }

  toolEnded(id: string): void {
    this.tools.delete(id);
    if (this.phase === 'streaming') this.armStall();
  }

  /** The attempt ended (done, paused, cancelled, failed): clear every timer. */
  stop(): void {
    this.phase = 'done';
    for (const t of [...this.handles.keys()]) this.clear(t);
    this.tools.clear();
  }
}
