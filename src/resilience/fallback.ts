import { backoffDelay, type BackoffOptions, type Failure } from './classify';
import type { ResolvedProfile } from './profiles';
import { realClock, type Clock } from './watchdog';

/**
 * Fallback across model profiles (blueprint section 8). The router keeps the ordered profiles
 * and the active one; a FallbackPlan follows one task: transient failures retry with backoff on
 * the same profile, hard ones (and transient ones after the retries) switch to the next profile
 * with no user action, fatal ones stop. When every profile has failed, the final message names
 * each failure. Nothing here knows a model name: labels come from the profiles.
 */

export type Decision =
  | {
      readonly action: 'retry';
      readonly delayMs: number;
      readonly retry: number;
      readonly of: number;
    }
  | {
      readonly action: 'switch';
      readonly from: ResolvedProfile;
      readonly to: ResolvedProfile;
      readonly failure: Failure;
      readonly message: string;
      /** Wait this long before using `to` (every profile is waiting out a rate limit). */
      readonly delayMs?: number;
    }
  | { readonly action: 'fail'; readonly message: string };

export interface RouterOptions {
  /** Retries on the same profile for transient failures (blueprint: 1 s, 2 s, 4 s). */
  readonly retries?: number;
  /**
   * Retries for timeouts (a stall, no first token, a header timeout): each already cost the
   * whole wait, so one retry, then the next profile.
   */
  readonly timeoutRetries?: number;
  /**
   * A server that asks to wait longer than this (Retry-After, "retry in 24s") is not waited for
   * while an untried profile is left: the task moves on at once. Default 10 s.
   */
  readonly maxRetryWaitMs?: number;
  /**
   * When every profile is waiting out a timed rate limit (a free tier's per-minute quota), the
   * task waits for the first one to come back, up to this much waiting in total. Default 3 min.
   */
  readonly maxQuotaWaitMs?: number;
  /**
   * Switches allowed in one task. Profiles that keep hitting their rate limit would otherwise
   * hand the task back and forth; past this the task ends with one clear line. Default 6.
   */
  readonly maxSwitches?: number;
  readonly backoff?: BackoffOptions;
  readonly clock?: Clock;
}

export interface FailureRecord {
  readonly failure: Failure;
  readonly at: number;
}

export const WORKSPACE_UNCHANGED = 'Nothing was applied; the workspace is unchanged.';

export function switchMessage(from: ResolvedProfile, to: ResolvedProfile, f: Failure): string {
  return `Switched to ${to.label} because ${from.label} ${f.reason}.`;
}

export function allFailedMessage(tried: readonly (readonly [ResolvedProfile, Failure])[]): string {
  const parts = tried.map(([p, f]) => `${p.name} (${p.label}) ${f.reason}`);
  return `All model profiles failed: ${parts.join('; ')}. ${WORKSPACE_UNCHANGED}`;
}

export class ModelRouter {
  private list: ResolvedProfile[];
  private activeName: string;
  private readonly listeners = new Set<() => void>();
  private readonly failed = new Map<string, FailureRecord>();
  readonly retries: number;
  readonly timeoutRetries: number;
  readonly clock: Clock;

  constructor(
    profiles: readonly ResolvedProfile[],
    readonly options: RouterOptions = {},
  ) {
    if (profiles.length === 0) throw new Error('ModelRouter needs at least one profile');
    this.list = [...profiles];
    this.activeName = this.list[0]?.name ?? '';
    this.retries = options.retries ?? 3;
    this.timeoutRetries = Math.min(options.timeoutRetries ?? 1, this.retries);
    this.clock = options.clock ?? realClock;
  }

  get profiles(): readonly ResolvedProfile[] {
    return this.list;
  }

  get primary(): ResolvedProfile {
    return this.list[0] as ResolvedProfile;
  }

  get active(): ResolvedProfile {
    return this.list.find((p) => p.name === this.activeName) ?? this.primary;
  }

  /** The last failure of a profile, until it recovers or is chosen again by the user. */
  lastFailure(name: string): FailureRecord | undefined {
    return this.failed.get(name);
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const l of [...this.listeners]) l();
  }

  /** New profiles (the setting changed). Keeps the active profile by name when it still exists. */
  setProfiles(profiles: readonly ResolvedProfile[]): void {
    if (profiles.length === 0) return;
    this.list = [...profiles];
    if (!this.list.some((p) => p.name === this.activeName)) this.activeName = this.primary.name;
    for (const name of [...this.failed.keys()])
      if (!this.list.some((p) => p.name === name)) this.failed.delete(name);
    this.fire();
  }

  /** The user (or a switch back) picks a profile; its failure mark is cleared. */
  setActive(name: string): boolean {
    if (!this.list.some((p) => p.name === name)) return false;
    this.activeName = name;
    this.failed.delete(name);
    this.fire();
    return true;
  }

  recordFailure(profile: ResolvedProfile, failure: Failure): void {
    this.failed.set(profile.name, { failure, at: this.clock.now() });
    this.fire();
  }

  recordHealthy(profile: ResolvedProfile): void {
    if (this.failed.delete(profile.name)) this.fire();
  }

  /** Profiles ahead of the active one that failed: candidates to switch back to. */
  failedAbove(): ResolvedProfile[] {
    const idx = this.list.findIndex((p) => p.name === this.active.name);
    return this.list.slice(0, Math.max(0, idx)).filter((p) => this.failed.has(p.name));
  }

  /** The next profile after `current` in order (wrapping), skipping `exclude`. */
  next(current: ResolvedProfile, exclude: ReadonlySet<string>): ResolvedProfile | undefined {
    const start = this.list.findIndex((p) => p.name === current.name);
    for (let i = 1; i <= this.list.length; i++) {
      const p = this.list[(start + i) % this.list.length];
      if (p && p.name !== current.name && !exclude.has(p.name)) return p;
    }
    return undefined;
  }

  /** Starts following one task, on the active profile. */
  begin(): FallbackPlan {
    return new FallbackPlan(this);
  }

  /** Internal: a plan switched profiles; later tasks start there too. */
  moveTo(profile: ResolvedProfile): void {
    this.activeName = profile.name;
    this.fire();
  }
}

export class FallbackPlan {
  private profile: ResolvedProfile;
  private retriesUsed = 0;
  private readonly tried: (readonly [ResolvedProfile, Failure])[] = [];

  constructor(private readonly router: ModelRouter) {
    this.profile = router.active;
  }

  get current(): ResolvedProfile {
    return this.profile;
  }

  /** Profiles that failed during this task, in order. */
  get failures(): readonly (readonly [ResolvedProfile, Failure])[] {
    return this.tried;
  }

  /** Profiles waiting out a timed rate limit in this task, with the time they come back. */
  private readonly quotaUntil = new Map<string, number>();
  private quotaWaitedMs = 0;
  private switches = 0;

  /** Tried profiles that cannot be used now: failed for good, or still inside their rate limit. */
  private blocked(now: number): Set<string> {
    const out = new Set<string>();
    for (const [p] of this.tried) {
      const until = this.quotaUntil.get(p.name);
      if (until === undefined || until > now) out.add(p.name);
    }
    return out;
  }

  /** What to do after a failure on the current profile. */
  decide(f: Failure): Decision {
    if (f.kind === 'fatal')
      return { action: 'fail', message: `${this.profile.label} ${f.reason}: ${f.detail}` };
    const now = this.router.clock.now();
    const limit = f.timeout ? this.router.timeoutRetries : this.router.retries;
    // A server that asks for a long wait is not waited for on the spot: another profile goes on.
    const longWait = (f.retryAfterMs ?? 0) > (this.router.options.maxRetryWaitMs ?? 10_000);
    if (f.kind === 'transient' && this.retriesUsed < limit && !longWait) {
      this.retriesUsed++;
      return {
        action: 'retry',
        delayMs: backoffDelay(this.retriesUsed, f, this.router.options.backoff),
        retry: this.retriesUsed,
        of: limit,
      };
    }
    const from = this.profile;
    this.tried.push([from, f]);
    this.router.recordFailure(from, f);
    // A timed rate limit ("retry in 24s") only blocks the profile until then; a per-minute quota
    // clears, so the profile can be used again later in the same task.
    if (f.kind === 'transient' && f.retryAfterMs !== undefined)
      this.quotaUntil.set(from.name, now + f.retryAfterMs);
    else this.quotaUntil.delete(from.name);
    if (this.switches >= (this.router.options.maxSwitches ?? 6))
      return {
        action: 'fail',
        message: `Gave up after ${this.switches} model switches: every model kept failing, last ${from.label} ${f.reason}. ${WORKSPACE_UNCHANGED}`,
      };
    const to = this.router.next(from, this.blocked(now));
    if (to) return this.moveTo(from, to, f, switchMessage(from, to, f));
    // Every profile is blocked. If some only wait out a rate limit, wait for the first to return.
    let soonest: { name: string; at: number } | undefined;
    for (const [name, at] of this.quotaUntil)
      if (!soonest || at < soonest.at) soonest = { name, at };
    const target = soonest && this.router.profiles.find((p) => p.name === soonest?.name);
    const wait = soonest ? Math.max(0, soonest.at - now) : 0;
    if (target && this.quotaWaitedMs + wait <= (this.router.options.maxQuotaWaitMs ?? 180_000)) {
      this.quotaWaitedMs += wait;
      return this.moveTo(
        from,
        target,
        f,
        `Every model is rate-limited; waiting ${Math.max(1, Math.round(wait / 1000))} s for ${target.label}.`,
        wait,
      );
    }
    return { action: 'fail', message: allFailedMessage(this.tried) };
  }

  private moveTo(
    from: ResolvedProfile,
    to: ResolvedProfile,
    f: Failure,
    message: string,
    delayMs?: number,
  ): Decision {
    this.profile = to;
    this.retriesUsed = 0;
    this.switches++;
    this.router.moveTo(to);
    return {
      action: 'switch',
      from,
      to,
      failure: f,
      message,
      ...(delayMs === undefined ? {} : { delayMs }),
    };
  }

  /** The current profile answered (the turn finished): it is healthy. */
  succeeded(): void {
    this.retriesUsed = 0;
    this.router.recordHealthy(this.profile);
  }
}

export interface RecoveryOptions {
  readonly router: ModelRouter;
  /** A tiny request to the profile; resolves true when it answers. */
  readonly probe: (profile: ResolvedProfile) => Promise<boolean>;
  readonly intervalMs?: number;
  /** Stops probing a profile after this many failed probes. */
  readonly maxProbes?: number;
  readonly clock?: Clock;
}

/**
 * While Swage runs on a fallback, probes the failed profiles ahead of it now and then. When one
 * answers, `onRecovered` fires once so the UI can offer to switch back (never automatically).
 */
export class RecoveryMonitor {
  private timer: unknown;
  private readonly probes = new Map<string, number>();
  private readonly listeners = new Set<(p: ResolvedProfile) => void>();
  private readonly sub: { dispose(): void };
  private busy = false;
  private readonly clock: Clock;

  constructor(private readonly opts: RecoveryOptions) {
    this.clock = opts.clock ?? realClock;
    this.sub = opts.router.onDidChange(() => this.schedule());
    this.schedule();
  }

  onRecovered(listener: (p: ResolvedProfile) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private candidates(): ResolvedProfile[] {
    const max = this.opts.maxProbes ?? 30;
    return this.opts.router.failedAbove().filter((p) => (this.probes.get(p.name) ?? 0) < max);
  }

  private schedule(): void {
    if (this.timer !== undefined || this.candidates().length === 0) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, this.opts.intervalMs ?? 120_000);
  }

  /** Probes every candidate once (also callable directly, for tests and a manual check). */
  async check(): Promise<ResolvedProfile[]> {
    if (this.busy) return [];
    this.busy = true;
    const recovered: ResolvedProfile[] = [];
    try {
      for (const p of this.candidates()) {
        this.probes.set(p.name, (this.probes.get(p.name) ?? 0) + 1);
        const ok = await this.opts.probe(p).catch(() => false);
        if (ok) {
          this.probes.delete(p.name);
          this.opts.router.recordHealthy(p);
          recovered.push(p);
          for (const l of [...this.listeners]) l(p);
        }
      }
    } finally {
      this.busy = false;
      this.schedule();
    }
    return recovered;
  }

  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.sub.dispose();
    this.listeners.clear();
  }
}
