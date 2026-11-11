/** Shared helpers for the TrueForge spikes. Prints facts, never secrets. */
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describeError } from '../../src/client/client';

export function sdkFor(baseUrl: string): TrueForge {
  return new TrueForge({ baseUrl, timeoutInSeconds: 600 });
}

export const QUIET_CONFIG: TrueForgeApi.RuntimeConfig = {
  sandbox: { enabled: false },
  generativeUi: { enabled: false },
  askUserQuestions: { enabled: false },
  dynamicSubAgents: { enabled: false },
  iterationLimit: 4,
};

export interface TurnRecord {
  readonly ms: number;
  readonly firstEventMs?: number;
  readonly firstTextMs?: number;
  readonly types: string[];
  readonly terminal?: TrueForgeApi.TurnDoneEvent['state'];
  readonly text: string;
  readonly toolCalls: string[];
  readonly toolResponses: string[];
  readonly transportError?: string;
  readonly cappedAt?: number;
}

/** Streams one turn and records event types, timings and the terminal state. */
export async function recordTurn(
  sdk: TrueForge,
  sessionId: string,
  input: TrueForgeApi.TurnInputItem[],
  capMs = 150_000,
): Promise<TurnRecord> {
  const started = Date.now();
  const types: string[] = [];
  const toolCalls: string[] = [];
  const toolResponses: string[] = [];
  let text = '';
  let firstEventMs: number | undefined;
  let firstTextMs: number | undefined;
  let terminal: TrueForgeApi.TurnDoneEvent['state'] | undefined;
  let cappedAt: number | undefined;
  const cap = setTimeout(() => {
    cappedAt = Date.now() - started;
    void sdk.sessions.cancel(sessionId).catch(() => undefined);
  }, capMs);
  try {
    const stream = await sdk.sessions.createTurnStream(sessionId, { input });
    for await (const event of stream) {
      firstEventMs ??= Date.now() - started;
      if (types.at(-1) !== event.type) types.push(event.type);
      if (
        event.type === 'model.message.delta' &&
        typeof event.content === 'string' &&
        event.content !== ''
      ) {
        firstTextMs ??= Date.now() - started;
        text += event.content;
      }
      if (event.type === 'model.message.delta') {
        for (const tc of event.toolCalls ?? [])
          if (tc.function?.name) toolCalls.push(tc.function.name);
      }
      if (event.type === 'model.message') {
        for (const tc of event.toolCalls ?? []) toolCalls.push(tc.function.name);
      }
      if (event.type === 'tool.response') toolResponses.push(event.content.slice(0, 120));
      if (event.type === 'turn.done') terminal = event.state;
    }
  } catch (err) {
    clearTimeout(cap);
    return {
      ms: Date.now() - started,
      types,
      text,
      toolCalls,
      toolResponses,
      transportError: describeError(err),
      ...(firstEventMs === undefined ? {} : { firstEventMs }),
    };
  }
  clearTimeout(cap);
  return {
    ms: Date.now() - started,
    types,
    text,
    toolCalls,
    toolResponses,
    ...(firstEventMs === undefined ? {} : { firstEventMs }),
    ...(firstTextMs === undefined ? {} : { firstTextMs }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(cappedAt === undefined ? {} : { cappedAt }),
  };
}

export function userMessage(content: string): TrueForgeApi.TurnInputItem[] {
  return [{ type: 'user.message', content }];
}

export function summarize(state: TurnRecord['terminal']): string {
  if (!state) return 'no turn.done';
  if (state.status === 'error') return `error: ${state.message}`;
  if (state.status === 'cancelled') return `cancelled: ${state.reason}`;
  return `done (${state.requiredActions.length} required actions)`;
}

export async function healthz(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? 'ok' : `http ${res.status}`;
  } catch (err) {
    return `down (${(err as Error).message})`;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
