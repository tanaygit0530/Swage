import { redactText } from '../safety/redact';

/**
 * Error classifier (blueprint section 8, resilience). Every model failure reaches Swage as a
 * `turn.done` error with a `[Model Error]` prefix (docs/SPIKES.md, S7); TrueForge's own HTTP
 * errors arrive as `TrueForge <status>: ...` from describeError. Three outcomes:
 *
 * - hard: the profile cannot work now (401, 403, connection refused, unknown model or agent).
 *   Switch to the next profile at once, no retry.
 * - transient: may pass (429, 5xx, timeouts, stalls). Retry with backoff, then switch.
 * - fatal: switching the model cannot help (our MCP server, TrueForge itself, a bug, a context
 *   or output limit). Show one clear line; do not switch.
 */

export type FailureKind = 'hard' | 'transient' | 'fatal';

export interface Failure {
  readonly kind: FailureKind;
  /** Short phrase completing "<model> ...", for banners: "returned 429", "refused the connection". */
  readonly reason: string;
  /** One redacted line for logs and the final error. */
  readonly detail: string;
  /** HTTP status if one was reported. */
  readonly status?: number;
  /** Server-suggested wait (Retry-After or "try again in Ns"). */
  readonly retryAfterMs?: number;
}

export type TimeoutKind = 'connect' | 'firstToken' | 'stall' | 'total';

function firstLine(text: string): string {
  return redactText(text.split('\n')[0] ?? text)
    .trim()
    .slice(0, 300);
}

function retryAfter(text: string): number | undefined {
  const m = /(?:try again in|retry[- ]after[:= ]*)\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(
    text,
  );
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === 'ms' ? Math.round(n) : Math.round(n * 1000);
}

function failure(
  kind: FailureKind,
  reason: string,
  detail: string,
  extra: { status?: number | undefined; retryAfterMs?: number | undefined } = {},
): Failure {
  return {
    kind,
    reason,
    detail: firstLine(detail),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  };
}

/**
 * Classifies an error message from a turn (`error` event) or from a failed TrueForge call
 * (describeError text).
 */
export function classifyMessage(message: string): Failure {
  const text = message.trim();
  const model = /^\[Model Error\]/i.test(text);
  const status =
    Number(/\((\d{3})\)/.exec(text)?.[1] ?? /\b(?:status|HTTP)\s*(\d{3})\b/i.exec(text)?.[1]) ||
    undefined;
  const trueforge = /^TrueForge (\d{3})\b/.exec(text);
  const tfStatus = trueforge ? Number(trueforge[1]) : undefined;

  // Not a model problem: our own MCP server, a context or output limit, TrueForge unreachable.
  if (/^\[MCP Error\]/i.test(text))
    return failure('fatal', 'could not reach the editor tools', text);
  if (/context (?:length|window)|maximum context|too many tokens|prompt is too long/i.test(text))
    return failure('fatal', 'ran out of context', text);
  if (/Output truncated/i.test(text)) return failure('fatal', 'hit its output limit', text);

  // TrueForge's own API answers (session or agent calls).
  if (tfStatus !== undefined) {
    if (/agent not found|unknown model|not configured on provider|model .* not found/i.test(text))
      return failure('hard', 'is not set up in TrueForge', text, { status: tfStatus });
    if (tfStatus === 401 || tfStatus === 403)
      return failure('fatal', 'was refused by TrueForge', text, { status: tfStatus });
    if (tfStatus === 429 || tfStatus >= 500)
      return failure('transient', `got TrueForge ${tfStatus}`, text, { status: tfStatus });
    return failure('fatal', `got TrueForge ${tfStatus}`, text, { status: tfStatus });
  }

  if (model) {
    if (status === 401 || status === 403 || /invalid api key|unauthori[sz]ed|forbidden/i.test(text))
      return failure('hard', `returned ${status ?? 401}`, text, { status: status ?? 401 });
    if (
      /ECONNREFUSED|bad port|ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|EHOSTUNREACH/i.test(text)
    )
      return failure('hard', 'refused the connection', text);
    if (
      status === 404 ||
      /does not exist|do not have access|model not found|unknown model|no such model/i.test(text)
    )
      return failure('hard', 'does not know the model', text, { status: status ?? 404 });
    if (status === 429 || /quota|rate limit/i.test(text))
      return failure('transient', 'returned 429', text, {
        status: 429,
        retryAfterMs: retryAfter(text),
      });
    if (status !== undefined && status >= 500)
      return failure('transient', `returned ${status}`, text, {
        status,
        retryAfterMs: retryAfter(text),
      });
    if (/timeout|timed out/i.test(text)) return failure('transient', 'timed out', text);
    if (/ECONNRESET|socket hang up|terminated|other side closed|network/i.test(text))
      return failure('transient', 'dropped the connection', text);
    if (status !== undefined && status >= 400)
      return failure('hard', `returned ${status}`, text, { status });
    // An unknown model-side error: give it a retry, then move on.
    return failure('transient', 'failed', text);
  }

  // Without a prefix: the stream to TrueForge itself, or TrueForge reaching our MCP server.
  if (/terminated|socket hang up|ECONNRESET|other side closed/i.test(text))
    return failure('transient', 'dropped the connection', text);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(text))
    return failure('fatal', 'could not reach TrueForge or the editor tools', text);
  return failure('fatal', 'failed', text);
}

/** A thrown error from a TrueForge call (session create, turn stream). */
export function classifyError(err: unknown, describe: (e: unknown) => string): Failure {
  return classifyMessage(describe(err));
}

/** Swage's own per-attempt timers expired. All are transient: retry, then switch. */
export function timeoutFailure(which: TimeoutKind, ms: number): Failure {
  const s = Math.round(ms / 1000);
  const reason =
    which === 'connect'
      ? `did not connect in ${s} s`
      : which === 'firstToken'
        ? `sent nothing in ${s} s`
        : which === 'stall'
          ? `stalled for ${s} s`
          : `ran past its ${s} s limit`;
  return failure('transient', reason, `Swage ${which} timer: ${reason}`);
}

export interface BackoffOptions {
  /** First delay (blueprint: 1 s, 2 s, 4 s). */
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Fraction of random spread, both ways (0.2 = plus or minus 20%). */
  readonly jitter?: number;
  readonly random?: () => number;
}

/**
 * Delay before retry `attempt` (1-based): base * 2^(attempt-1) with jitter, never less than a
 * server's Retry-After.
 */
export function backoffDelay(attempt: number, f: Failure, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 8000;
  const jitter = opts.jitter ?? 0.2;
  const random = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const spread = exp * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.max(exp + spread, f.retryAfterMs ?? 0)));
}
