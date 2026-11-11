import { TrueForgeError, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SdkLike } from '../../src/client/client';
import { FINAL_TEXT, type Scenario, type ScenarioStep } from '../fake-model/scenario';

/**
 * A scripted stand-in for TrueForge in the fast tests. It plays a fake-model scenario the way
 * TrueForge runs a turn, using the event shapes verified in docs/SPIKES.md: `turn.created`, an
 * empty `model.message` then `model.message.delta` events, tool calls executed against Swage's
 * real MCP server over HTTP, `tool.response`, `tool.approval_required` and `turn.done`. Gated tools
 * pause the turn; `user.tool_approval` resumes it. `sessions.cancel` ends the turn with
 * `cancelled`/`client-cancelled` after any running MCP call returns (TrueForge waits for running
 * MCP calls); a new turn in a session cancels the running one with `cancelled-for-next-turn`.
 *
 * Assumption (not documented by TrueForge): the text of the tool.response for a denied call.
 */

type Ev = TrueForgeApi.TurnStreamingEvent;

interface Turn {
  readonly id: string;
  cancelled: boolean;
  reason: 'client-cancelled' | 'cancelled-for-next-turn';
  readonly waiters: Set<() => void>;
}

interface Session {
  readonly id: string;
  step: number;
  readonly pending: Map<string, { name: string; args: Record<string, unknown> }>;
  active: Turn | undefined;
  readonly scenario: Scenario;
  readonly model: string;
}

export interface FakeTrueForgeOptions {
  /** The scenario for sessions whose model has no entry in `scenarios`. */
  readonly scenario: Scenario;
  /**
   * Scenarios by TrueForge model FQN, for fallback tests: a session on an agent plays the
   * scenario of the agent's model. With this set, a session on an agent that was never created
   * fails with TrueForge's 404, and a model without a scenario with its 422.
   */
  readonly scenarios?: Readonly<Record<string, Scenario>>;
  readonly mcp: { url: string; token: string };
  readonly gated?: readonly string[];
  /** Emit a delta and a tool.response after the cancelled turn.done, to test late-event dropping. */
  readonly staleEventAfterCancel?: boolean;
}

const at = (): string => new Date().toISOString();

export class FakeTrueForge {
  readonly log: string[] = [];
  /** Every turn's input, by session, for checking what a model was sent. */
  readonly inputs: { sessionId: string; input: TrueForgeApi.TurnInputItem[] }[] = [];
  private readonly sessionsById = new Map<string, Session>();
  private client: Client | undefined;
  private counter = 0;
  private readonly gated: readonly string[];
  private readonly agentModels = new Map<string, string>();
  /** Attempts per model and step, so a failing step with errorTimes recovers like the real fake model. */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly opts: FakeTrueForgeOptions) {
    this.gated = opts.gated ?? ['submit_change_set', 'run_command'];
  }

  get sdk(): SdkLike {
    return this as unknown as SdkLike;
  }

  private async mcp(): Promise<Client> {
    if (!this.client) {
      this.client = new Client({ name: 'fake-trueforge', version: '0' });
      await this.client.connect(
        new StreamableHTTPClientTransport(new URL(this.opts.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${this.opts.mcp.token}` } },
        }),
      );
    }
    return this.client;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  // Setup calls (MCP registration and agent upsert) are accepted and recorded.
  readonly agents = {
    list: (req: { agentName?: string }): Promise<AsyncGenerator<{ id: string; name: string }>> => {
      const found = [...this.agentModels.keys()].filter((n) => n === req.agentName);
      return Promise.resolve(
        (async function* () {
          for (const name of found) yield { id: `agent-${name}`, name };
        })(),
      );
    },
    create: (req: {
      name: string;
      manifest?: { model?: { name?: string } };
    }): Promise<{ data: { id: string } }> => {
      this.log.push(`agent.create ${req.name}`);
      const model = req.manifest?.model?.name;
      if (this.opts.scenarios && model && !this.opts.scenarios[model])
        return Promise.reject(
          new TrueForgeError({
            message: `Unknown model "${model}"`,
            statusCode: 422,
            body: { error: { message: `Unknown model "${model}" — not configured on provider` } },
          }),
        );
      this.agentModels.set(req.name, model ?? '');
      return Promise.resolve({ data: { id: `agent-${req.name}` } });
    },
    update: (
      id: string,
      req: { manifest?: { model?: { name?: string } } },
    ): Promise<{ data: { id: string } }> => {
      const name = id.replace(/^agent-/, '');
      this.log.push(`agent.update ${name}`);
      this.agentModels.set(name, req.manifest?.model?.name ?? '');
      return Promise.resolve({ data: { id } });
    },
  };

  readonly settings = {
    mcpServers: {
      createOrUpdate: (req: {
        manifest: { name: string; url: string };
      }): Promise<{ data: object }> => {
        this.log.push(`mcp.register ${req.manifest.name}`);
        return Promise.resolve({ data: {} });
      },
    },
  };

  readonly mcpServers = {
    listTools: async (): Promise<{ data: { name: string }[] }> => {
      const tools = await (await this.mcp()).listTools();
      return { data: tools.tools.map((t) => ({ name: t.name })) };
    },
  };

  readonly models = {
    list: (): Promise<{ data: { name: string }[] }> =>
      Promise.resolve({
        data: [
          { name: `swage-fake/${this.opts.scenario.name}` },
          ...Object.keys(this.opts.scenarios ?? {}).map((name) => ({ name })),
        ],
      }),
  };

  readonly sessions = {
    create: (req: {
      agent: { name?: string; spec?: { model?: { name?: string } } };
    }): Promise<{ data: { id: string } }> => {
      const name = req.agent.name;
      let model = req.agent.spec?.model?.name ?? '';
      let scenario = this.opts.scenario;
      if (this.opts.scenarios) {
        if (name !== undefined) {
          const m = this.agentModels.get(name);
          if (m === undefined)
            return Promise.reject(
              new TrueForgeError({
                message: 'Agent not found',
                statusCode: 404,
                body: { error: { message: `Agent not found: ${name}` } },
              }),
            );
          model = m;
        }
        scenario = this.opts.scenarios[model] ?? scenario;
      }
      const id = `sess-${++this.counter}`;
      this.sessionsById.set(id, {
        id,
        step: 0,
        pending: new Map(),
        active: undefined,
        scenario,
        model,
      });
      this.log.push(`session.create ${name ?? 'inline'}${model ? ` (${model})` : ''}`);
      return Promise.resolve({ data: { id } });
    },
    cancel: (sessionId: string): Promise<{ data: object }> => {
      this.log.push(`session.cancel ${sessionId}`);
      const turn = this.sessionsById.get(sessionId)?.active;
      if (turn && !turn.cancelled) {
        turn.cancelled = true;
        turn.reason = 'client-cancelled';
        for (const wake of [...turn.waiters]) wake();
      }
      return Promise.resolve({ data: {} });
    },
    createTurnStream: (
      sessionId: string,
      req: { input?: TrueForgeApi.TurnInputItem[] },
    ): Promise<AsyncGenerator<Ev>> => {
      const session = this.sessionsById.get(sessionId);
      if (!session) return Promise.reject(new Error(`no session ${sessionId}`));
      this.log.push(`turn ${req.input?.[0]?.type ?? 'empty'}`);
      this.inputs.push({ sessionId, input: req.input ?? [] });
      return Promise.resolve(this.play(session, req.input ?? []));
    },
  };

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await (await this.mcp()).callTool({ name, arguments: args })) as CallToolResult;
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  private async *play(session: Session, input: TrueForgeApi.TurnInputItem[]): AsyncGenerator<Ev> {
    const previous = session.active;
    if (previous && !previous.cancelled) {
      previous.cancelled = true;
      previous.reason = 'cancelled-for-next-turn';
      for (const wake of [...previous.waiters]) wake();
    }
    const turn: Turn = {
      id: `turn-${++this.counter}`,
      cancelled: false,
      reason: 'client-cancelled',
      waiters: new Set(),
    };
    session.active = turn;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          turn.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        turn.waiters.add(done);
      });
    const cancelled = function* (this: FakeTrueForge): Generator<Ev> {
      yield {
        type: 'turn.done',
        id: `done-${turn.id}`,
        createdAt: at(),
        threadId: null,
        state: { status: 'cancelled', completedAt: at(), reason: turn.reason },
      } as Ev;
      if (this.opts.staleEventAfterCancel) {
        yield {
          type: 'model.message.delta',
          id: 'stale-msg',
          threadId: 'main',
          content: 'STALE',
        } as Ev;
        yield {
          type: 'tool.response',
          id: 'stale-tool',
          createdAt: at(),
          threadId: 'main',
          toolCallId: 'stale',
          content: 'STALE',
        } as Ev;
      }
    }.bind(this);

    yield {
      type: 'turn.created',
      id: `created-${turn.id}`,
      createdAt: at(),
      threadId: null,
      turnId: turn.id,
      input,
      state: { status: 'running' },
    } as unknown as Ev;

    // Resume after approvals: run allowed calls, report denied ones.
    if (input[0]?.type === 'user.tool_approval') {
      for (const item of input) {
        if (item.type !== 'user.tool_approval') continue;
        const call = session.pending.get(item.toolCallId);
        if (!call) continue;
        const content =
          item.approval.status === 'allow'
            ? await this.callTool(call.name, call.args)
            : `Tool call denied by the user${item.approval.reason ? `: ${item.approval.reason}` : ''}.`;
        yield {
          type: 'tool.response',
          id: `resp-${item.toolCallId}`,
          createdAt: at(),
          threadId: 'main',
          toolCallId: item.toolCallId,
          content,
        } as Ev;
      }
      session.pending.clear();
      if (turn.cancelled) {
        yield* cancelled();
        return;
      }
    }

    for (;;) {
      const stepIndex = session.step++;
      const step: ScenarioStep = session.scenario.steps[stepIndex] ?? { text: [FINAL_TEXT] };
      const msgId = `msg-${turn.id}-${stepIndex}`;

      const key = `${session.scenario.name}#${stepIndex}`;
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      if (
        step.error !== undefined &&
        (step.errorTimes === undefined || attempt <= step.errorTimes)
      ) {
        // A failed request adds nothing to the conversation, so the retry replays this step.
        session.step = stepIndex;
        this.log.push(
          `model.error ${session.model || session.scenario.name} ${String(step.error)}`,
        );
        if (step.error === 'hang') {
          await sleep(3_600_000);
          if (turn.cancelled) {
            yield* cancelled();
            return;
          }
        }
        const message =
          step.error === 429
            ? '[Model Error] Request failed (429): Rate limit reached for requests. Please try again in 1s.'
            : step.error === 401
              ? '[Model Error] Request failed (401): Invalid API Key'
              : step.error === 500
                ? '[Model Error] Request failed (500): The server had an error while processing your request.'
                : '[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:8787';
        yield {
          type: 'model.message',
          id: msgId,
          createdAt: at(),
          threadId: 'main',
          content: '',
        } as Ev;
        yield {
          type: 'turn.done',
          id: `done-${turn.id}`,
          createdAt: at(),
          threadId: null,
          state: { status: 'error', completedAt: at(), message },
        } as Ev;
        return;
      }

      yield {
        type: 'model.message',
        id: msgId,
        createdAt: at(),
        threadId: 'main',
        content: '',
        toolCalls: [],
      } as Ev;
      if (step.firstTokenDelayMs) await sleep(step.firstTokenDelayMs);
      let full = '';
      for (const [i, piece] of (step.text ?? []).entries()) {
        if (turn.cancelled) break;
        full += piece;
        yield { type: 'model.message.delta', id: msgId, threadId: 'main', content: piece } as Ev;
        if (step.stallAfterChunks !== undefined && i + 1 === step.stallAfterChunks)
          await sleep(step.stallMs ?? 60_000);
        else if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
      }
      if (turn.cancelled) {
        yield* cancelled();
        return;
      }

      // A deferred tool arrives as call_tool { mcp_server, tool_name, input }; TrueForge resolves it to the
      // underlying tool (trueforge-core DeferredTool.ts), so its tool info and gating use the real name.
      const calls = (step.toolCalls ?? []).map((c, i) => {
        const wrapped = c.name === 'call_tool' && typeof c.arguments['tool_name'] === 'string';
        return {
          id: `call_${stepIndex}_${i}`,
          name: wrapped ? String(c.arguments['tool_name']) : c.name,
          args: wrapped
            ? ((c.arguments['input'] as Record<string, unknown> | undefined) ?? {})
            : c.arguments,
          rawName: c.name,
          rawArgs: c.arguments,
        };
      });
      for (const [i, c] of calls.entries()) {
        yield {
          type: 'model.message.delta',
          id: msgId,
          threadId: 'main',
          toolCalls: [
            {
              index: i,
              id: c.id,
              type: 'function',
              function: { name: c.rawName, arguments: JSON.stringify(c.rawArgs) },
              toolInfo: {
                type: 'mcp',
                name: c.name,
                serverId: 'srv-editor-tools',
                serverName: 'editor-tools',
              },
            },
          ],
        } as Ev;
      }
      yield {
        type: 'model.message.delta',
        id: msgId,
        threadId: 'main',
        finishReason: calls.length ? 'tool_calls' : 'stop',
      } as Ev;

      if (calls.length === 0) {
        const output = {
          type: 'model.message',
          id: msgId,
          createdAt: at(),
          threadId: 'main',
          content: full,
        };
        yield {
          type: 'turn.done',
          id: `done-${turn.id}`,
          createdAt: at(),
          threadId: null,
          state: { status: 'done', completedAt: at(), output, requiredActions: [] },
        } as Ev;
        return;
      }

      const gatedCalls = calls.filter((c) => this.gated.includes(c.name));
      for (const c of calls.filter((x) => !this.gated.includes(x.name))) {
        // TrueForge waits for a running MCP call to finish, even after cancel.
        const content = await this.callTool(c.name, c.args);
        this.log.push(`tool ${c.name} ${content.replace(/\s+/g, ' ').slice(0, 400)}`);
        yield {
          type: 'tool.response',
          id: `resp-${c.id}`,
          createdAt: at(),
          threadId: 'main',
          toolCallId: c.id,
          content,
        } as Ev;
        if (turn.cancelled) break;
      }
      if (turn.cancelled) {
        yield* cancelled();
        return;
      }
      if (gatedCalls.length > 0) {
        for (const c of gatedCalls) session.pending.set(c.id, { name: c.name, args: c.args });
        const approval = {
          type: 'tool.approval_required',
          id: `approval-${turn.id}`,
          createdAt: at(),
          threadId: 'main',
          toolCalls: gatedCalls.map((c) => ({ id: c.id, sourceEventId: msgId })),
        };
        yield approval as Ev;
        yield {
          type: 'turn.done',
          id: `done-${turn.id}`,
          createdAt: at(),
          threadId: null,
          state: { status: 'done', completedAt: at(), output: null, requiredActions: [approval] },
        } as Ev;
        return;
      }
    }
  }
}
