import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  classifyError,
  classifyMessage,
  timeoutFailure,
  type Failure,
} from '../../../src/resilience/classify';

const kind = (m: string): [string, string] => {
  const f = classifyMessage(m);
  return [f.kind, f.reason];
};

describe('classify (blueprint section 8; messages as recorded in docs/SPIKES.md)', () => {
  it('hard: 401, 403, connection refused, unknown model or agent switch at once', () => {
    expect(kind('[Model Error] Request failed (401): Invalid API Key')).toEqual([
      'hard',
      'returned 401',
    ]);
    expect(kind('[Model Error] Request failed (403): Forbidden')).toEqual(['hard', 'returned 403']);
    expect(
      kind('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:54895'),
    ).toEqual(['hard', 'refused the connection']);
    expect(kind('[Model Error] Cannot connect to API: bad port')).toEqual([
      'hard',
      'refused the connection',
    ]);
    expect(
      kind(
        '[Model Error] Request failed (404): The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.',
      ),
    ).toEqual(['hard', 'does not know the model']);
    expect(kind('TrueForge 404: Agent not found: swage-inline-fallback-1')).toEqual([
      'hard',
      'is not set up in TrueForge',
    ]);
    expect(
      kind('TrueForge 422: Unknown model "groq/gpt-oss-120b" — not configured on provider'),
    ).toEqual(['hard', 'is not set up in TrueForge']);
    expect(kind('[Model Error] Request failed (400): bad request')).toEqual([
      'hard',
      'returned 400',
    ]);
  });

  it('transient: 429 (with Retry-After), 5xx, header timeouts, dropped streams retry first', () => {
    const quota = classifyMessage(
      '[Model Error] Request failed (429): You exceeded your current quota, please check your plan and billing details.',
    );
    expect([quota.kind, quota.reason, quota.status]).toEqual(['transient', 'returned 429', 429]);
    expect(
      classifyMessage(
        '[Model Error] Request failed (429): Rate limit reached. Please try again in 1s.',
      ).retryAfterMs,
    ).toBe(1000);
    expect(classifyMessage('[Model Error] Rate limit, retry-after: 250ms').retryAfterMs).toBe(250);
    expect(
      kind('[Model Error] Request failed (503): This model is currently experiencing high demand.'),
    ).toEqual(['transient', 'returned 503']);
    expect(kind('[Model Error] Request failed (500): The server had an error')).toEqual([
      'transient',
      'returned 500',
    ]);
    expect(kind('[Model Error] Cannot connect to API: Headers Timeout Error')).toEqual([
      'transient',
      'timed out',
    ]);
    expect(kind('[Model Error] socket hang up')).toEqual(['transient', 'dropped the connection']);
    expect(kind('terminated')).toEqual(['transient', 'dropped the connection']);
    expect(kind('[Model Error] something new')).toEqual(['transient', 'failed']);
    expect(kind('TrueForge 503: busy')).toEqual(['transient', 'got TrueForge 503']);
  });

  it('fatal: our MCP server, TrueForge unreachable, context or output limits; never switch', () => {
    expect(kind("[MCP Error] Failed to connect to remote MCP server 'editor-tools'")[0]).toBe(
      'fatal',
    );
    expect(kind('fetch failed: connect ECONNREFUSED 127.0.0.1:55052')[0]).toBe('fatal');
    expect(kind('[Model Error] maximum context length exceeded')).toEqual([
      'fatal',
      'ran out of context',
    ]);
    expect(kind('Output truncated: hit the 512 token limit after 508 tokens')[0]).toBe('fatal');
    expect(kind('TrueForge 400: bad session spec')[0]).toBe('fatal');
    expect(kind('TrueForge 401: unauthorised')[0]).toBe('fatal');
    expect(kind('TypeError: x is not a function')).toEqual(['fatal', 'failed']);
  });

  it('reads statuses written without parentheses and wording without a status', () => {
    expect(kind('[Model Error] upstream HTTP 502 bad gateway')).toEqual([
      'transient',
      'returned 502',
    ]);
    expect(kind('[Model Error] Unauthorized')).toEqual(['hard', 'returned 401']);
    expect(kind('[Model Error] no such model: x')).toEqual(['hard', 'does not know the model']);
    expect(kind('TrueForge 404: Session not found')).toEqual(['fatal', 'got TrueForge 404']);
  });

  it('redacts secrets and keeps one line', () => {
    const f = classifyMessage(
      '[Model Error] Request failed (401): Invalid API Key sk-abcdefghijklmnopqrstuvwxyz0123456789\nstack',
    );
    expect(f.detail).not.toMatch(/sk-abcdef/);
    expect(f.detail).not.toContain('\n');
  });

  it('classifies thrown errors through describeError and names timers plainly', () => {
    expect(classifyError(new Error('x'), () => 'TrueForge 404: Agent not found: a').kind).toBe(
      'hard',
    );
    expect(timeoutFailure('firstToken', 45_000)).toMatchObject({
      kind: 'transient',
      reason: 'sent nothing in 45 s',
    });
    expect(timeoutFailure('stall', 30_000).reason).toBe('stalled for 30 s');
    expect(timeoutFailure('connect', 10_000).reason).toBe('did not connect in 10 s');
    expect(timeoutFailure('total', 600_000).reason).toBe('ran past its 600 s limit');
  });
});

describe('backoff', () => {
  const f: Failure = { kind: 'transient', reason: 'returned 500', detail: '' };
  it('doubles from 1 s (1, 2, 4 s) with jitter, capped, honouring Retry-After', () => {
    const mid = { random: () => 0.5 };
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(a, f, mid))).toEqual([
      1000, 2000, 4000, 8000, 8000,
    ]);
    expect(backoffDelay(1, f, { random: () => 0 })).toBe(800);
    expect(backoffDelay(1, f, { random: () => 1 })).toBe(1200);
    expect(backoffDelay(1, { ...f, retryAfterMs: 5000 }, mid)).toBe(5000);
    expect(backoffDelay(2, f, { baseMs: 10, random: () => 0.5 })).toBe(20);
  });
});
