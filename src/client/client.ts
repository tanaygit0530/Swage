import { TrueForge, TrueForgeError, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { redactText } from '../safety/redact';
import { TurnEventMapper, type PendingToolCall, type SwageEvent } from './events';
import { assertAgentName, type AgentSpec } from './manifest';

/**
 * Thin wrapper over @truefoundry/trueforge-sdk 0.184.1 (blueprint sections 4, 6 and 8).
 * Every call below is a documented SDK method; see docs/SPIKES.md for what was verified.
 * The extension never calls a model provider: everything goes through TrueForge.
 */

/** The SDK surface Swage uses, so tests can pass a fake. */
export interface SdkLike {
  readonly agents: Pick<TrueForge['agents'], 'list' | 'create' | 'update'>;
  readonly sessions: Pick<TrueForge['sessions'], 'create' | 'createTurnStream' | 'cancel'>;
  readonly settings: {
    readonly mcpServers: Pick<TrueForge['settings']['mcpServers'], 'createOrUpdate'>;
  };
  readonly mcpServers: Pick<TrueForge['mcpServers'], 'listTools'>;
  readonly models: Pick<TrueForge['models'], 'list'>;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Default 600 s: the SDK default of 60 s is too short for streamed turns (blueprint section 8). */
  readonly timeoutInSeconds?: number;
  readonly sdk?: SdkLike;
}

export interface ApprovalDecision {
  readonly threadId: string;
  readonly toolCallId: string;
  readonly allow: boolean;
  readonly reason?: string;
}

export interface McpRegistration {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  /** Bearer token for the MCP server. Sent once to TrueForge; never logged or returned. */
  readonly bearerToken: string;
}

/** A readable message for any SDK or network error, with secrets redacted. */
export function describeError(err: unknown): string {
  if (err instanceof TrueForgeError) {
    const body = err.body as { error?: { message?: string }; message?: string } | undefined;
    const detail = body?.error?.message ?? body?.message ?? err.message;
    return redactText(`TrueForge ${err.statusCode ?? 'error'}: ${detail}`);
  }
  return redactText(err instanceof Error ? err.message : String(err));
}

export class SwageClient {
  readonly sdk: SdkLike;

  constructor(options: ClientOptions) {
    this.sdk =
      options.sdk ??
      new TrueForge({
        baseUrl: options.baseUrl,
        timeoutInSeconds: options.timeoutInSeconds ?? 600,
      });
  }

  /** Creates the agent, or updates it if the name exists. Names are immutable in TrueForge. */
  async upsertAgent(
    name: string,
    description: string,
    manifest: AgentSpec,
  ): Promise<{ id: string; created: boolean }> {
    assertAgentName(name);
    let existing: TrueForgeApi.Agent | undefined;
    for await (const agent of await this.sdk.agents.list({ agentName: name })) {
      if (agent.name === name) {
        existing = agent;
        break;
      }
    }
    if (existing) {
      await this.sdk.agents.update(existing.id, { description, manifest });
      return { id: existing.id, created: false };
    }
    const { data } = await this.sdk.agents.create({ name, description, manifest });
    return { id: data.id, created: true };
  }

  /** Registers (or replaces) a remote MCP server with header auth. */
  async registerMcpServer(reg: McpRegistration): Promise<void> {
    assertAgentName(reg.name);
    await this.sdk.settings.mcpServers.createOrUpdate({
      manifest: {
        type: 'remote',
        name: reg.name,
        url: reg.url,
        description: reg.description,
        auth: { type: 'header', headers: { Authorization: `Bearer ${reg.bearerToken}` } },
      },
    });
  }

  async listMcpTools(name: string): Promise<string[]> {
    const { data } = await this.sdk.mcpServers.listTools(name);
    // The SDK types tools as plain records (MCP `tools/list` entries); `name` is a string there.
    return data.map((t) => String(t['name'] ?? ''));
  }

  async listModels(): Promise<string[]> {
    const { data } = await this.sdk.models.list();
    return data.map((m) => m.name);
  }

  /** Opens a session on a named agent. */
  async createSession(agentName: string): Promise<string> {
    const { data } = await this.sdk.sessions.create({ agent: { name: agentName } });
    return data.id;
  }

  /** Opens a session with an inline spec, for example a fallback model (blueprint section 6). */
  async createInlineSession(spec: AgentSpec): Promise<string> {
    const { data } = await this.sdk.sessions.create({ agent: { spec } });
    return data.id;
  }

  /**
   * Streams one turn as SwageEvents. The stream always ends with exactly one of
   * `done`, `cancelled` or `error`; a transport failure becomes an `error` event.
   */
  async *streamTurn(
    sessionId: string,
    input: TrueForgeApi.TurnInputItem[],
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SwageEvent> {
    const mapper = new TurnEventMapper();
    let finished = false;
    try {
      const stream = await this.sdk.sessions.createTurnStream(
        sessionId,
        { input },
        options.signal ? { abortSignal: options.signal } : undefined,
      );
      for await (const event of stream) {
        for (const out of mapper.map(event)) {
          if (out.type === 'done' || out.type === 'cancelled' || out.type === 'error')
            finished = true;
          yield out;
        }
      }
      if (!finished)
        yield { type: 'error', message: 'The TrueForge stream ended without a final event.' };
    } catch (err) {
      if (!finished) {
        if (options.signal?.aborted) yield { type: 'cancelled', reason: 'client-cancelled' };
        else yield { type: 'error', message: describeError(err) };
      }
    }
  }

  /** Sends a user message and streams the turn. */
  sendMessage(
    sessionId: string,
    text: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SwageEvent> {
    return this.streamTurn(sessionId, [{ type: 'user.message', content: text }], options);
  }

  /**
   * Resumes a paused turn with one `user.tool_approval` per pending call. Approvals cannot be
   * mixed with a user message in the same turn (verified in the TrueForge docs).
   */
  resumeWithApprovals(
    sessionId: string,
    decisions: readonly ApprovalDecision[],
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SwageEvent> {
    if (decisions.length === 0) throw new Error('resumeWithApprovals needs at least one decision');
    const input: TrueForgeApi.TurnInputItem[] = decisions.map((d) => ({
      type: 'user.tool_approval',
      threadId: d.threadId,
      toolCallId: d.toolCallId,
      approval: d.allow
        ? { status: 'allow' }
        : { status: 'deny', ...(d.reason === undefined ? {} : { reason: d.reason }) },
    }));
    return this.streamTurn(sessionId, input, options);
  }

  /**
   * Cancels the running turn. TrueForge aborts the model request, waits for running MCP
   * calls, and ends the stream itself with `turn.done` (cancelled). Idempotent.
   */
  async cancel(sessionId: string): Promise<void> {
    await this.sdk.sessions.cancel(sessionId);
  }
}

/** Allow-all decisions for a list of pending calls (used once the user has reviewed them). */
export function allowAll(pending: readonly PendingToolCall[]): ApprovalDecision[] {
  return pending.map((p) => ({ threadId: p.threadId, toolCallId: p.toolCallId, allow: true }));
}
