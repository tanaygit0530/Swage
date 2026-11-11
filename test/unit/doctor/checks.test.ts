import { describe, expect, it } from 'vitest';
import {
  doctorMarkdown,
  nodeAtLeast,
  probeFix,
  runDoctor,
  summary,
  type DoctorDeps,
} from '../../../src/doctor/checks';
import { resolveProfiles } from '../../../src/resilience/profiles';
import type { Failure } from '../../../src/resilience/classify';

const profiles = resolveProfiles([
  { name: 'primary', label: 'Gemini', trueforgeModel: 'google-gemini/flash' },
  { name: 'fallback-1', label: 'Groq', trueforgeModel: 'groq/oss' },
  { name: 'fallback-2', label: 'Ollama', kind: 'local', trueforgeModel: 'ollama/qwen' },
]);
const TOOLS = [
  'find_relevant_code',
  'read_files',
  'declare_context',
  'stage_edit',
  'submit_change_set',
];

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    profiles,
    trueforgeUrl: 'http://localhost:8790',
    pinnedVersion: '0.184.2',
    run: (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      const table: Record<string, string> = {
        'node --version': 'v26.8.2',
        'rg --version': 'ripgrep 14.1.1\nfeatures',
        '/w/.venv/bin/python --version': 'Python 3.13.9',
        '/w/.venv/bin/python -m pytest --version': 'pytest 9.0.2',
      };
      const out = table[key];
      return Promise.resolve(
        out === undefined ? { ok: false, output: 'not found' } : { ok: true, output: out },
      );
    },
    trueforgeVersion: () => Promise.resolve('0.184.2'),
    mcpToolsViaTrueForge: () => Promise.resolve(TOOLS),
    mcpDirect: () => Promise.resolve({ withToken: true, withoutTokenRefused: true }),
    ensureAgents: (p) => Promise.resolve([`swage-main-${p.name}`, `swage-inline-${p.name}`]),
    probe: () => Promise.resolve({ ok: true, ms: 1234, detail: 'called repo_map' }),
    pythonCandidates: ['/w/.venv/bin/python', 'python3'],
    workspaceTrusted: true,
    ...over,
  };
}

const byId = (rs: Awaited<ReturnType<typeof runDoctor>>) =>
  Object.fromEntries(rs.map((r) => [r.id, r]));

describe('Swage: Doctor (blueprint F8)', () => {
  it('all green: every check passes, with details', async () => {
    const rs = await runDoctor(deps());
    expect(rs.map((r) => r.id)).toEqual([
      'node',
      'trueforge',
      'mcp',
      'agents:primary',
      'probe:primary',
      'agents:fallback-1',
      'probe:fallback-1',
      'agents:fallback-2',
      'probe:fallback-2',
      'ripgrep',
      'python',
      'pytest',
      'trust',
    ]);
    expect(rs.every((r) => r.status === 'pass')).toBe(true);
    const r = byId(rs);
    expect(r['node']?.detail).toBe('v26.8.2');
    expect(r['probe:primary']?.detail).toBe('called repo_map in 1.2 s');
    expect(r['python']?.detail).toBe('Python 3.13.9 (/w/.venv/bin/python)');
    expect(summary(rs)).toBe('13 passed, 0 failed, 0 warning(s), 0 skipped');
  });

  it('TrueForge down: fails with a fix, and skips what needs it', async () => {
    const rs = byId(await runDoctor(deps({ trueforgeVersion: () => Promise.resolve(undefined) })));
    expect(rs['trueforge']).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/trueforge\/start\.sh/),
    });
    expect(rs['mcp']?.status).toBe('skip');
    expect(rs['probe:fallback-2']?.status).toBe('skip');
    expect(rs['python']?.status).toBe('pass');
  });

  it('flags old Node, a different TrueForge version, missing tools, untrusted workspace, no pytest', async () => {
    const rs = byId(
      await runDoctor(
        deps({
          run: (cmd, args) =>
            Promise.resolve(
              cmd === 'node'
                ? { ok: true, output: 'v20.11.0' }
                : cmd === 'python3' && args[0] === '--version'
                  ? { ok: true, output: 'Python 3.12.1' }
                  : { ok: false, output: '' },
            ),
          trueforgeVersion: () => Promise.resolve('0.190.0'),
          mcpToolsViaTrueForge: () => Promise.resolve(['read_files']),
          workspaceTrusted: false,
          bundledRipgrep: '/app/rg',
        }),
      ),
    );
    expect(rs['node']).toMatchObject({ status: 'fail', detail: 'v20.11.0' });
    expect(rs['trueforge']).toMatchObject({
      status: 'warn',
      fix: expect.stringMatching(/0\.184\.2/),
    });
    expect(rs['mcp']).toMatchObject({
      status: 'fail',
      detail: expect.stringMatching(/missing declare_context/),
    });
    expect(rs['ripgrep']).toMatchObject({
      status: 'pass',
      detail: expect.stringMatching(/bundled/),
    });
    expect(rs['python']?.detail).toBe('Python 3.12.1 (python3)');
    expect(rs['pytest']).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/pip install pytest/),
    });
    expect(rs['trust']).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/Manage Workspace Trust/),
    });
  });

  it('MCP server problems: no answer, or answering without the token', async () => {
    const silent = byId(
      await runDoctor(
        deps({ mcpDirect: () => Promise.resolve({ withToken: false, withoutTokenRefused: true }) }),
      ),
    );
    expect(silent['mcp']?.status).toBe('fail');
    const open = byId(
      await runDoctor(
        deps({ mcpDirect: () => Promise.resolve({ withToken: true, withoutTokenRefused: false }) }),
      ),
    );
    expect(open['mcp']?.detail).toMatch(/without the token/);
    const thrown = byId(
      await runDoctor(deps({ mcpDirect: () => Promise.reject(new Error('Open a folder first')) })),
    );
    expect(thrown['mcp']).toMatchObject({ status: 'fail', detail: 'Open a folder first' });
  });

  it('model profiles: unknown model, bad key, no tool call, rate limit (a warning on a fallback)', async () => {
    const f401: Failure = { kind: 'hard', reason: 'returned 401', detail: 'x', status: 401 };
    const f429: Failure = {
      kind: 'transient',
      reason: 'returned 429',
      detail: 'quota',
      status: 429,
    };
    const rs = byId(
      await runDoctor(
        deps({
          ensureAgents: (p) =>
            p.name === 'fallback-2'
              ? Promise.reject(new Error('TrueForge 422: Unknown model'))
              : Promise.resolve(['a']),
          probe: (p) =>
            Promise.resolve(
              p.name === 'primary'
                ? { ok: false, ms: 10, detail: 'Invalid API Key', failure: f401 }
                : { ok: false, ms: 10, detail: 'quota', failure: f429 },
            ),
        }),
      ),
    );
    expect(rs['probe:primary']).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/API key/),
    });
    expect(rs['probe:fallback-1']).toMatchObject({
      status: 'warn',
      fix: expect.stringMatching(/rate limited/),
    });
    expect(rs['agents:fallback-2']).toMatchObject({
      status: 'fail',
      fix: expect.stringMatching(/Add the model ollama\/qwen/),
    });
    expect(rs['probe:fallback-2']?.status).toBe('skip');
  });

  it('turns a thrown check into a failure instead of crashing', async () => {
    const rs = byId(
      await runDoctor(deps({ run: () => Promise.reject(new Error('spawn EACCES')) })),
    );
    expect(rs['node']).toMatchObject({ status: 'fail', detail: 'spawn EACCES' });
  });

  it('fix hints follow the classified failure', () => {
    const [g, , o] = profiles;
    if (!g || !o) throw new Error('profiles');
    expect(probeFix(g, undefined, 'answered without calling a tool: "hi"')).toMatch(/calls tools/);
    expect(probeFix(o, undefined, 'no answer in 90 s')).toMatch(/firstTokenMs/);
    expect(
      probeFix(g, { kind: 'hard', reason: 'does not know the model', detail: '' }, ''),
    ).toMatch(/Add the model/);
    expect(probeFix(o, { kind: 'hard', reason: 'refused the connection', detail: '' }, '')).toMatch(
      /local model server/,
    );
    expect(probeFix(g, { kind: 'hard', reason: 'refused the connection', detail: '' }, '')).toMatch(
      /base URL/,
    );
    expect(probeFix(g, { kind: 'fatal', reason: 'x', detail: '' }, '')).toMatch(
      /restart TrueForge/,
    );
    expect(
      probeFix(g, { kind: 'transient', reason: 'returned 503', detail: '', status: 503 }, ''),
    ).toMatch(/not answering reliably/);
  });

  it('compares Node versions', () => {
    expect(nodeAtLeast('v22.14.0')).toBe(true);
    expect(nodeAtLeast('v22.13.9')).toBe(false);
    expect(nodeAtLeast('v24.0.0')).toBe(true);
    expect(nodeAtLeast('garbage')).toBe(false);
  });

  it('renders a pass or fail table with a fix per failure', async () => {
    const rs = await runDoctor(deps({ workspaceTrusted: false }));
    const md = doctorMarkdown(rs, new Date('2026-11-11T10:00:00Z'));
    expect(md).toContain('# Swage: Doctor');
    expect(md).toContain('12 passed, 1 failed, 0 warning(s), 0 skipped · 2026-11-11 10:00:00 UTC');
    expect(md).toContain('| Check | Result | Details | Fix |');
    expect(md).toMatch(
      /\| Workspace trusted \| ❌ fail \| Restricted Mode \| Run "Workspaces: Manage Workspace Trust"/,
    );
    expect(md).toMatch(/\| Node\.js 22\.14 or newer \| ✅ pass \| v26\.8\.2 \| {2}\|/);
  });
});
