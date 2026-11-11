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
    }
  | { readonly action: 'fail'; readonly message: string };

export interface RouterOptions {
  /** Retries on the same profile for transient failures (blueprint: 1 s, 2 s, 4 s). */
  readonly retries?: number;
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
  readonly clock: Clock;

  constructor(
    profiles: readonly ResolvedProfile[],
    readonly options: RouterOptions = {},
  ) {
    if (profiles.length === 0) throw new Error('ModelRouter needs at least one profile');
    this.list = [...profiles];
    this.activeName = this.list[0]?.name ?? '';
    this.retries = options.retries ?? 3;
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

  /** What to do after a failure on the current profile. */
  decide(f: Failure): Decision {
    if (f.kind === 'fatal')
      return { action: 'fail', message: `${this.profile.label} ${f.reason}: ${f.detail}` };
    if (f.kind === 'transient' && this.retriesUsed < this.router.retries) {
      this.retriesUsed++;
      return {
        action: 'retry',
        delayMs: backoffDelay(this.retriesUsed, f, this.router.options.backoff),
        retry: this.retriesUsed,
        of: this.router.retries,
      };
    }
    const from = this.profile;
    this.tried.push([from, f]);
    this.router.recordFailure(from, f);
    const to = this.router.next(from, new Set(this.tried.map(([p]) => p.name)));
    if (!to) return { action: 'fail', message: allFailedMessage(this.tried) };
    this.profile = to;
    this.retriesUsed = 0;
    this.router.moveTo(to);
    return { action: 'switch', from, to, failure: f, message: switchMessage(from, to, f) };
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
