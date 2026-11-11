import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SwageClient, type SdkLike } from '../../../src/client/client';
import { MODEL_PLACEHOLDER, toWireManifest } from '../../../src/client/manifest';
import {
  formatReport,
  loadManifests,
  MCP_SERVER_NAME,
  parseProfiles,
  runSetup,
} from '../../../src/client/setup';

const manifests = loadManifests('trueforge/agents');

describe('agent manifests (blueprint section 6)', () => {
  it('parse through the SDK schema and keep the model placeholder', () => {
    expect(manifests['swage-main'].model.name).toBe(MODEL_PLACEHOLDER);
    expect(manifests['swage-inline'].model.name).toBe(MODEL_PLACEHOLDER);
  });

  it('main agent: hot tools preloaded, submit and run_command gated, harness defaults overridden', () => {
    expect(toWireManifest(manifests['swage-main'])).toEqual({
      model: { name: '<provider>/<model>', params: { temperature: 0, max_tokens: 4096 } },
      instructions:
        'Short workflow: plan, retrieve, declare, stage, test, submit. Done means code, test and docs are updated.',
      mcp_servers: [
        {
          name: 'editor-tools',
          enable_tools: ['@all'],
          preload: false,
          preload_tools: [
            'find_relevant_code',
            'read_files',
            'declare_context',
            'stage_edit',
            'submit_change_set',
          ],
          require_approval_for_tools: ['submit_change_set', 'run_command'],
        },
      ],
      config: {
        sandbox: { enabled: false },
        generative_ui: { enabled: false },
        ask_user_questions: { enabled: false },
        dynamic_sub_agents: { enabled: false },
        context_management: {
          compaction: { enabled: true },
          large_tool_response: { enabled: false },
        },
        iteration_limit: 30,
      },
    });
  });

  it('inline agent: only declare_context and stage_edit, 8 iterations', () => {
    const wire = toWireManifest(manifests['swage-inline']) as {
      mcp_servers: { enable_tools: string[] }[];
      config: { iteration_limit: number };
    };
    expect(wire.mcp_servers[0]?.enable_tools).toEqual(['declare_context', 'stage_edit']);
    expect(wire.config.iteration_limit).toBe(8);
  });
});

describe('profiles', () => {
  it('parses the example profiles', () => {
    const profiles = parseProfiles(readFileSync('config/models.example.json', 'utf8'));
    expect(profiles.map((p) => `${p.name}=${p.trueforgeModel}`)).toEqual([
      'primary=google-gemini/gemini-3-5-flash',
      'fallback-1=groq/llama-3-3-70b-versatile',
      'fallback-2=ollama/qwen-2-5-coder-7b',
    ]);
  });

  it('rejects bad profile files', () => {
    expect(() => parseProfiles('{"profiles": []}')).toThrow(/non-empty/);
    expect(() => parseProfiles('{"profiles": [{"name": "p"}]}')).toThrow(/profile 0/);
  });
});

function fakeClient(opts: { models?: string[]; failAgent?: string; failMcp?: boolean } = {}) {
  const calls: string[] = [];
  const created = new Set<string>(['swage-main-primary']);
  const sdk = {
    models: {
      list: () =>
        Promise.resolve({
          data: (opts.models ?? ['google-gemini/gemini-3-5-flash']).map((name) => ({ name })),
        }),
    },
    settings: {
      mcpServers: {
        createOrUpdate: (req: { manifest: { auth: unknown } }) => {
          calls.push(`mcp.put ${JSON.stringify(req.manifest.auth)}`);
          return opts.failMcp
            ? Promise.reject(new Error('424 cannot reach http://127.0.0.1:1/mcp'))
            : Promise.resolve({ data: {} });
        },
      },
    },
    mcpServers: {
      listTools: () => Promise.resolve({ data: [{ name: 'read_files' }, { name: 'stage_edit' }] }),
    },
    agents: {
      list: (q: { agentName: string }) =>
        Promise.resolve(
          (async function* () {
            if (created.has(q.agentName)) yield { id: `id-${q.agentName}`, name: q.agentName };
          })(),
        ),
      create: (req: { name: string }) => {
        calls.push(`agent.create ${req.name}`);
        if (req.name === opts.failAgent) return Promise.reject(new Error('422 unknown model'));
        created.add(req.name);
        return Promise.resolve({ data: { id: `id-${req.name}` } });
      },
      update: (id: string) => {
        calls.push(`agent.update ${id}`);
        return Promise.resolve({ data: { id } });
      },
    },
    sessions: {},
  };
  return {
    client: new SwageClient({ baseUrl: 'http://x', sdk: sdk as unknown as SdkLike }),
    calls,
  };
}

const profiles = [
  { name: 'primary', trueforgeModel: 'google-gemini/gemini-3-5-flash' },
  { name: 'fallback-1', trueforgeModel: 'groq/llama-3-3-70b-versatile' },
];

describe('runSetup', () => {
  it('registers the MCP server first, then upserts main and inline agents per profile', async () => {
    const { client, calls } = fakeClient();
    const token = 'tok-' + 'abc123';
    const report = await runSetup({
      client,
      profiles,
      manifests,
      mcp: { url: 'http://127.0.0.1:5000/mcp', bearerToken: token },
    });
    expect(calls).toEqual([
      `mcp.put {"type":"header","headers":{"Authorization":"Bearer ${token}"}}`,
      'agent.update id-swage-main-primary',
      'agent.create swage-inline-primary',
      'agent.create swage-main-fallback-1',
      'agent.create swage-inline-fallback-1',
    ]);
    expect(report.mcp).toEqual({ status: 'registered', tools: ['read_files', 'stage_edit'] });
    expect(report.missingModels).toEqual(['groq/llama-3-3-70b-versatile']);
    expect(report.agents.map((a) => `${a.name}:${a.result}`)).toEqual([
      'swage-main-primary:updated',
      'swage-inline-primary:created',
      'swage-main-fallback-1:created',
      'swage-inline-fallback-1:created',
    ]);
    const text = formatReport(report).join('\n');
    expect(text).toContain(
      `MCP server ${MCP_SERVER_NAME}: registered (2 tools: read_files, stage_edit)`,
    );
    expect(text).toContain('Model groq/llama-3-3-70b-versatile is not configured in TrueForge');
    expect(text).not.toContain(token);
  });

  it('is idempotent: a second run only updates', async () => {
    const { client } = fakeClient();
    await runSetup({ client, profiles, manifests });
    const second = await runSetup({ client, profiles, manifests });
    expect(second.agents.every((a) => a.result === 'updated')).toBe(true);
    expect(second.mcp.status).toBe('skipped');
    expect(formatReport(second)[0]).toMatch(/skipped \(set SWAGE_MCP_URL and SWAGE_MCP_TOKEN/);
  });

  it('reports MCP and per-agent failures without stopping', async () => {
    const { client } = fakeClient({ failAgent: 'swage-inline-primary', failMcp: true });
    const report = await runSetup({
      client,
      profiles,
      manifests,
      mcp: { url: 'http://127.0.0.1:1/mcp', bearerToken: 't' },
    });
    expect(report.mcp).toMatchObject({ status: 'error', error: expect.stringMatching(/424/) });
    expect(report.agents.find((a) => a.name === 'swage-inline-primary')).toMatchObject({
      result: 'error',
      error: '422 unknown model',
    });
    expect(report.agents.filter((a) => a.result !== 'error')).toHaveLength(3);
    expect(formatReport(report).join('\n')).toContain('FAILED');
  });
});
