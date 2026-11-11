import { TrueForgeError, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';
import { allowAll, describeError, SwageClient, type SdkLike } from '../../../src/client/client';
import { TurnEventMapper, type SwageEvent } from '../../../src/client/events';
import {
  agentNameFor,
  assertAgentName,
  parseManifest,
  slug,
  toWireManifest,
  withProfile,
} from '../../../src/client/manifest';

type Ev = TrueForgeApi.TurnStreamingEvent;
const at = '2026-11-11T10:00:00Z';

/** A realistic turn: text, a streamed tool call, a tool result, more text, then done. */
function toolTurn(): Ev[] {
  return [
    {
      type: 'turn.created',
      id: 'e0',
      createdAt: at,
      threadId: null,
      turnId: 'turn-1',
      input: [],
      state: { status: 'running' },
    } as unknown as Ev,
    {
      type: 'model.message',
      id: 'm1',
      createdAt: at,
      threadId: 'main',
      content: '',
      toolCalls: [],
    } as Ev,
    { type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'Looking for ' } as Ev,
    { type: 'model.message.delta', id: 'm1', threadId: 'main', content: 'the CLI.' } as Ev,
    {
      type: 'model.message.delta',
      id: 'm1',
      threadId: 'main',
      toolCalls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'find_relevant_code', arguments: '{"query":' },
          toolInfo: {
            type: 'mcp',
            name: 'find_relevant_code',
            serverId: 's1',
            serverName: 'editor-tools',
          },
        },
      ],
    } as Ev,
    {
      type: 'model.message.delta',
      id: 'm1',
      threadId: 'main',
      toolCalls: [{ index: 0, function: { arguments: '"cli"}' } }],
    } as Ev,
    { type: 'model.message.delta', id: 'm1', threadId: 'main', finishReason: 'tool_calls' } as Ev,
    {
      type: 'tool.response',
      id: 'e2',
      createdAt: at,
      threadId: 'main',
      toolCallId: 'call-1',
      content: '{"hits":3}',
    } as Ev,
    { type: 'model.message', id: 'm2', createdAt: at, threadId: 'main', content: '' } as Ev,
    { type: 'model.message.delta', id: 'm2', threadId: 'main', content: 'Done.' } as Ev,
    { type: 'model.message.delta', id: 'm2', threadId: 'main', finishReason: 'stop' } as Ev,
    {
      type: 'turn.done',
      id: 'e9',
      createdAt: at,
      threadId: null,
      state: {
        status: 'done',
        completedAt: at,
        output: {
          type: 'model.message',
          id: 'm2',
          createdAt: at,
          threadId: 'main',
          content: 'Done.',
        },
        requiredActions: [],
        metrics: { totalTokens: 1234 },
      },
    } as Ev,
  ];
}

function mapAll(events: Ev[]): SwageEvent[] {
  const mapper = new TurnEventMapper();
  return events.flatMap((e) => mapper.map(e));
}

describe('TurnEventMapper', () => {
  it('maps a tool-using turn to text deltas, tool start and result, and done', () => {
    expect(mapAll(toolTurn())).toEqual([
      { type: 'turn_started', turnId: 'turn-1' },
      { type: 'text', threadId: 'main', messageId: 'm1', delta: 'Looking for ' },
      { type: 'text', threadId: 'main', messageId: 'm1', delta: 'the CLI.' },
      {
        type: 'tool_start',
        threadId: 'main',
        toolCallId: 'call-1',
        name: 'find_relevant_code',
        arguments: '{"query":"cli"}',
        server: 'editor-tools',
      },
      { type: 'tool_result', threadId: 'main', toolCallId: 'call-1', content: '{"hits":3}' },
      { type: 'text', threadId: 'main', messageId: 'm2', delta: 'Done.' },
      { type: 'done', output: 'Done.', paused: false, pending: [], totalTokens: 1234 },
    ]);
  });

  it('resolves approval refs to tool names and arguments, and reports a paused done', () => {
    const msg = {
      type: 'model.message',
      id: 'm9',
      createdAt: at,
      threadId: 'main',
      content: [{ type: 'text', text: 'Submitting.' }],
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call-sub',
          type: 'function',
          function: { name: 'submit_change_set', arguments: '{"changeSetId":"cs-1"}' },
          toolInfo: {
            type: 'mcp',
            name: 'submit_change_set',
            serverId: 's1',
            serverName: 'editor-tools',
          },
        },
      ],
    } as Ev;
    const ref = { id: 'call-sub', sourceEventId: 'm9' };
    const events = [
      msg,
      {
        type: 'tool.approval_required',
        id: 'a1',
        createdAt: at,
        threadId: 'main',
        toolCalls: [ref],
      } as Ev,
      {
        type: 'turn.done',
        id: 'd1',
        createdAt: at,
        threadId: null,
        state: {
          status: 'done',
          completedAt: at,
          output: null,
          requiredActions: [
            {
              type: 'tool.approval_required',
              id: 'a1',
              createdAt: at,
              threadId: 'main',
              toolCalls: [ref],
            },
          ],
        },
      } as Ev,
    ];
    const out = mapAll(events);
    const pending = {
      threadId: 'main',
      toolCallId: 'call-sub',
      sourceEventId: 'm9',
      name: 'submit_change_set',
      arguments: '{"changeSetId":"cs-1"}',
      server: 'editor-tools',
    };
    expect(out).toEqual([
      { type: 'text', threadId: 'main', messageId: 'm9', delta: 'Submitting.' },
      {
        type: 'tool_start',
        threadId: 'main',
        toolCallId: 'call-sub',
        name: 'submit_change_set',
        arguments: '{"changeSetId":"cs-1"}',
        server: 'editor-tools',
      },
      { type: 'approval_required', calls: [pending] },
      { type: 'done', output: '', paused: true, pending: [pending] },
    ]);
  });

  it('maps cancelled and error endings', () => {
    expect(
      mapAll([
        {
          type: 'turn.done',
          id: 'd',
          createdAt: at,
          threadId: null,
          state: { status: 'cancelled', completedAt: at, reason: 'client-cancelled' },
        } as Ev,
      ]),
    ).toEqual([{ type: 'cancelled', reason: 'client-cancelled' }]);
    expect(
      mapAll([
        {
          type: 'turn.done',
          id: 'd',
          createdAt: at,
          threadId: null,
          state: { status: 'error', completedAt: at, message: 'Invalid API key' },
        } as Ev,
      ]),
    ).toEqual([{ type: 'error', message: 'Invalid API key' }]);
  });

  it('handles unknown refs, system tools and ignored event types', () => {
    const mapper = new TurnEventMapper();
    expect(
      mapper.map({
        type: 'tool.approval_required',
        id: 'a',
        createdAt: at,
        threadId: 'main',
        toolCalls: [{ id: 'x', sourceEventId: 'nope' }],
      } as Ev),
    ).toEqual([
      {
        type: 'approval_required',
        calls: [
          {
            threadId: 'main',
            toolCallId: 'x',
            sourceEventId: 'nope',
            name: 'unknown',
            arguments: '{}',
          },
        ],
      },
    ]);
    expect(
      mapper.map({
        type: 'mcp.initialize',
        id: 'i',
        createdAt: at,
        threadId: 'main',
        mcpServers: [],
      } as unknown as Ev),
    ).toEqual([]);
    expect(
      mapper.map({
        type: 'model.message.delta',
        id: 'orphan',
        threadId: 'main',
        content: 'x',
      } as Ev),
    ).toEqual([{ type: 'text', threadId: 'main', messageId: 'orphan', delta: 'x' }]);
    const sys = mapper.map({
      type: 'model.message',
      id: 's',
      createdAt: at,
      threadId: 'main',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'q',
          type: 'function',
          function: { name: 'ask_user_question', arguments: '{}' },
          toolInfo: { type: 'truefoundry-system', name: 'ask_user_question' },
        },
      ],
    } as Ev);
    expect(sys).toEqual([
      {
        type: 'tool_start',
        threadId: 'main',
        toolCallId: 'q',
        name: 'ask_user_question',
        arguments: '{}',
      },
    ]);
    expect(mapper.message('s')?.id).toBe('s');
    expect(mapper.message('a')).toBeUndefined();
  });
});

function fakeSdk(events: Ev[] = toolTurn()) {
  const calls: { method: string; args: unknown[] }[] = [];
  const agents = [
    { id: 'agent-1', name: 'swage-main-primary' },
    { id: 'agent-2', name: 'swage-main-primary-old' },
  ];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const sdk = {
    agents: {
      list: (...args: unknown[]) => {
        calls.push({ method: 'agents.list', args });
        const q = (args[0] as { agentName?: string } | undefined)?.agentName ?? '';
        return Promise.resolve(
          (async function* () {
            for (const a of agents) if (a.name.includes(q)) yield a;
          })(),
        );
      },
      create: record('agents.create', { data: { id: 'agent-new' } }),
      update: record('agents.update', { data: { id: 'agent-1' } }),
    },
    sessions: {
      create: record('sessions.create', { data: { id: 'sess-1' } }),
      createTurnStream: (...args: unknown[]) => {
        calls.push({ method: 'sessions.createTurnStream', args });
        return Promise.resolve(
          (async function* () {
            for (const e of events) yield e;
          })(),
        );
      },
      cancel: record('sessions.cancel', { data: {} }),
    },
    settings: {
      mcpServers: { createOrUpdate: record('settings.mcpServers.createOrUpdate', { data: {} }) },
    },
    mcpServers: {
      listTools: record('mcpServers.listTools', {
        data: [{ name: 'read_files' }, { name: 'stage_edit' }],
      }),
    },
    models: { list: record('models.list', { data: [{ name: 'google-gemini/gemini-3-5-flash' }] }) },
  };
  return { sdk: sdk as unknown as SdkLike, calls };
}

async function collect(gen: AsyncGenerator<SwageEvent>): Promise<SwageEvent[]> {
  const out: SwageEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const MANIFEST = JSON.stringify({
  model: { name: '<provider>/<model>', params: { temperature: 0, max_tokens: 4096 } },
  instructions: 'x',
  mcp_servers: [{ name: 'editor-tools', enable_tools: ['@all'], preload: false }],
});

describe('SwageClient', () => {
  it('updates an existing agent found by exact name, otherwise creates it', async () => {
    const { sdk, calls } = fakeSdk();
    const client = new SwageClient({ baseUrl: 'http://x', sdk });
    const spec = parseManifest(MANIFEST);
    expect(await client.upsertAgent('swage-main-primary', 'Swage agent', spec)).toEqual({
      id: 'agent-1',
      created: false,
    });
    expect(calls.find((c) => c.method === 'agents.update')?.args[0]).toBe('agent-1');
    expect(await client.upsertAgent('swage-inline-primary', 'Swage inline', spec)).toEqual({
      id: 'agent-new',
      created: true,
    });
    expect(calls.find((c) => c.method === 'agents.create')?.args[0]).toMatchObject({
      name: 'swage-inline-primary',
      description: 'Swage inline',
    });
    await expect(client.upsertAgent('trueforge', 'x', spec)).rejects.toThrow(/reserved/);
    await expect(client.upsertAgent('Bad_Name', 'x', spec)).rejects.toThrow(
      /not a valid TrueForge name/,
    );
  });

  it('registers the MCP server with bearer header auth', async () => {
    const { sdk, calls } = fakeSdk();
    const client = new SwageClient({ baseUrl: 'http://x', sdk });
    await client.registerMcpServer({
      name: 'editor-tools',
      url: 'http://127.0.0.1:5123/mcp',
      description: 'Swage editor tools',
      bearerToken: 't0ken-value',
    });
    expect(calls.at(-1)).toEqual({
      method: 'settings.mcpServers.createOrUpdate',
      args: [
        {
          manifest: {
            type: 'remote',
            name: 'editor-tools',
            url: 'http://127.0.0.1:5123/mcp',
            description: 'Swage editor tools',
            auth: { type: 'header', headers: { Authorization: 'Bearer t0ken-value' } },
          },
        },
      ],
    });
    expect(await client.listMcpTools('editor-tools')).toEqual(['read_files', 'stage_edit']);
    expect(await client.listModels()).toEqual(['google-gemini/gemini-3-5-flash']);
  });

  it('creates named and inline sessions, streams a message and cancels', async () => {
    const { sdk, calls } = fakeSdk();
    const client = new SwageClient({ baseUrl: 'http://x', sdk });
    expect(await client.createSession('swage-main-primary')).toBe('sess-1');
    expect(calls.at(-1)?.args[0]).toEqual({ agent: { name: 'swage-main-primary' } });
    await client.createInlineSession(parseManifest(MANIFEST));
    expect(calls.at(-1)?.args[0]).toMatchObject({ agent: { spec: { instructions: 'x' } } });

    const controller = new AbortController();
    const events = await collect(
      client.sendMessage('sess-1', 'say hello', { signal: controller.signal }),
    );
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'text',
      'text',
      'tool_start',
      'tool_result',
      'text',
      'done',
    ]);
    const streamCall = calls.find((c) => c.method === 'sessions.createTurnStream');
    expect(streamCall?.args.slice(0, 2)).toEqual([
      'sess-1',
      { input: [{ type: 'user.message', content: 'say hello' }] },
    ]);
    expect(streamCall?.args[2]).toEqual({ abortSignal: controller.signal });

    await client.cancel('sess-1');
    expect(calls.at(-1)).toEqual({ method: 'sessions.cancel', args: ['sess-1'] });
  });

  it('resumes with one user.tool_approval per decision', async () => {
    const { sdk, calls } = fakeSdk();
    const client = new SwageClient({ baseUrl: 'http://x', sdk });
    await collect(
      client.resumeWithApprovals('sess-1', [
        { threadId: 'main', toolCallId: 'c1', allow: true },
        { threadId: 'main', toolCallId: 'c2', allow: false, reason: 'rejected in review' },
        { threadId: 'main', toolCallId: 'c3', allow: false },
      ]),
    );
    expect(calls.at(-1)?.args[1]).toEqual({
      input: [
        {
          type: 'user.tool_approval',
          threadId: 'main',
          toolCallId: 'c1',
          approval: { status: 'allow' },
        },
        {
          type: 'user.tool_approval',
          threadId: 'main',
          toolCallId: 'c2',
          approval: { status: 'deny', reason: 'rejected in review' },
        },
        {
          type: 'user.tool_approval',
          threadId: 'main',
          toolCallId: 'c3',
          approval: { status: 'deny' },
        },
      ],
    });
    expect(() => client.resumeWithApprovals('sess-1', [])).toThrow(/at least one decision/);
    expect(
      allowAll([
        { threadId: 'main', toolCallId: 'x', sourceEventId: 'm', name: 'n', arguments: '{}' },
      ]),
    ).toEqual([{ threadId: 'main', toolCallId: 'x', allow: true }]);
  });

  it('turns a stream without a final event, a transport error and an abort into terminal events', async () => {
    const short = fakeSdk(toolTurn().slice(0, 3));
    expect(
      (await collect(new SwageClient({ baseUrl: 'x', sdk: short.sdk }).sendMessage('s', 'hi'))).at(
        -1,
      ),
    ).toEqual({
      type: 'error',
      message: 'The TrueForge stream ended without a final event.',
    });

    const failing = fakeSdk();
    (
      failing.sdk.sessions as unknown as { createTurnStream: () => Promise<never> }
    ).createTurnStream = () =>
      Promise.reject(
        new TrueForgeError({ statusCode: 502, body: { error: { message: 'Bad gateway' } } }),
      );
    expect(
      await collect(new SwageClient({ baseUrl: 'x', sdk: failing.sdk }).sendMessage('s', 'hi')),
    ).toEqual([{ type: 'error', message: 'TrueForge 502: Bad gateway' }]);

    const controller = new AbortController();
    controller.abort();
    const aborted = fakeSdk();
    (
      aborted.sdk.sessions as unknown as { createTurnStream: () => Promise<never> }
    ).createTurnStream = () => Promise.reject(new Error('This operation was aborted'));
    expect(
      await collect(
        new SwageClient({ baseUrl: 'x', sdk: aborted.sdk }).sendMessage('s', 'hi', {
          signal: controller.signal,
        }),
      ),
    ).toEqual([{ type: 'cancelled', reason: 'client-cancelled' }]);
  });

  it('builds a real SDK client by default', () => {
    expect(new SwageClient({ baseUrl: 'http://127.0.0.1:1' }).sdk).toBeDefined();
  });
});

describe('describeError', () => {
  it('redacts secrets and reads TrueForge error bodies', () => {
    const key = 'gs' + 'k_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    expect(describeError(new Error(`401 for key ${key}`))).toBe('401 for key [REDACTED:groq_key]');
    expect(
      describeError(new TrueForgeError({ statusCode: 404, body: { message: 'Agent not found' } })),
    ).toBe('TrueForge 404: Agent not found');
    expect(describeError(new TrueForgeError({ message: 'boom' }))).toBe('TrueForge error: boom');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('manifest helpers', () => {
  it('validates names and builds per-profile agent names', () => {
    expect(() => assertAgentName('tfg')).toThrow(/reserved/);
    expect(slug('Fallback 1')).toBe('fallback-1');
    expect(agentNameFor('swage-main', { name: 'primary', trueforgeModel: 'a/b' })).toBe(
      'swage-main-primary',
    );
    expect(
      agentNameFor('swage-inline', { name: 'Fallback 2 (Ollama)', trueforgeModel: 'a/b' }),
    ).toBe('swage-inline-fallback-2-ollama');
  });

  it('parses the wire format strictly and fills in the profile model', () => {
    const spec = parseManifest(MANIFEST);
    expect(spec.mcpServers?.[0]?.enableTools).toEqual(['@all']);
    expect(() => parseManifest(MANIFEST.replace('mcp_servers', 'mcp_server'), 'bad.json')).toThrow(
      /bad\.json: .*Unexpected key "mcp_server"/,
    );
    expect(() =>
      parseManifest(JSON.stringify({ model: { name: 'a/b' }, mcp_servers: [{ name: 'other' }] })),
    ).toThrow(/editor-tools/);
    const filled = withProfile(spec, {
      name: 'primary',
      trueforgeModel: 'google-gemini/gemini-3-5-flash',
      params: { temperature: 0.2 },
    });
    expect(filled.model).toEqual({
      name: 'google-gemini/gemini-3-5-flash',
      params: { temperature: 0.2, maxTokens: 4096 },
    });
    expect(toWireManifest(filled)).toMatchObject({
      model: {
        name: 'google-gemini/gemini-3-5-flash',
        params: { temperature: 0.2, max_tokens: 4096 },
      },
    });
    expect(() => withProfile(spec, { name: 'p', trueforgeModel: 'gemini' })).toThrow(/FQN/);
    const sized = withProfile(spec, {
      name: 'p',
      trueforgeModel: 'a/b',
      params: { max_tokens: 1024 },
    });
    expect(sized.model.params).toEqual({ temperature: 0, maxTokens: 1024 });
    expect(toWireManifest(sized)).toMatchObject({
      model: { params: { temperature: 0, max_tokens: 1024 } },
    });
  });
});
