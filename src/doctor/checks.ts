import type { Failure } from '../resilience/classify';
import type { ProbeResult } from '../resilience/probe';
import type { ResolvedProfile } from '../resilience/profiles';

/**
 * Swage: Doctor (blueprint section 3, F8): every check the demo depends on, each with a fix hint.
 * The checks are pure functions of injected probes, so they run in tests without VS Code,
 * TrueForge or a network.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about a warning or failure. */
  readonly fix?: string;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly output: string;
}

export interface DoctorDeps {
  readonly profiles: readonly ResolvedProfile[];
  readonly trueforgeUrl: string;
  readonly pinnedVersion: string;
  /** `node --version` on PATH: TrueForge runs on it. */
  run(cmd: string, args: readonly string[]): Promise<CommandResult>;
  /** TrueForge's /healthz version, or undefined when unreachable. */
  trueforgeVersion(): Promise<string | undefined>;
  /** Tools TrueForge sees on Swage's MCP server (it calls with the registered token). */
  mcpToolsViaTrueForge(): Promise<readonly string[]>;
  /** Swage's MCP server answers with the token and refuses without it. */
  mcpDirect(): Promise<{ withToken: boolean; withoutTokenRefused: boolean }>;
  /** Creates or updates the agent (main and inline) for a profile; rejects with TrueForge's error. */
  ensureAgents(profile: ResolvedProfile): Promise<readonly string[]>;
  probe(profile: ResolvedProfile): Promise<ProbeResult>;
  /** Python interpreters to try, best first (a workspace .venv before the system one). */
  readonly pythonCandidates: readonly string[];
  readonly workspaceTrusted: boolean;
  /** VS Code's bundled ripgrep, if any. */
  readonly bundledRipgrep?: string;
}

export const MIN_NODE = [22, 14] as const;

export function nodeAtLeast(version: string, min: readonly [number, number] = MIN_NODE): boolean {
  const m = /v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** A fix hint for a failed model probe, from the classifier's reading of the error. */
export function probeFix(p: ResolvedProfile, f: Failure | undefined, detail: string): string {
  const where = `TrueForge Settings, Models (${p.trueforgeModel.split('/')[0] ?? ''})`;
  if (!f)
    return /without calling a tool/.test(detail)
      ? `Pick a model that calls tools reliably for profile ${p.name} (blueprint S9).`
      : `Check that ${p.label} is running and answers; for a local model raise timeouts.firstTokenMs.`;
  if (f.reason === 'is not set up in TrueForge' || f.reason === 'does not know the model')
    return `Add the model ${p.trueforgeModel} in ${where}, or change profile ${p.name} in swage.models.`;
  if (f.status === 401 || f.status === 403)
    return `Check the API key for this provider in ${where}.`;
  if (f.reason === 'refused the connection')
    return p.kind === 'local'
      ? `Start the local model server and check its base URL in ${where}.`
      : `Check the provider's base URL in ${where}.`;
  if (f.status === 429)
    return `${p.label} is rate limited or out of quota: wait, or put another profile first.`;
  if (f.kind === 'fatal')
    return 'Swage could not reach TrueForge or its own tools: restart TrueForge and reload the window.';
  return `${p.label} is not answering reliably right now: try again, or put another profile first.`;
}

async function check(
  id: string,
  title: string,
  body: () => Promise<Omit<CheckResult, 'id' | 'title'>>,
): Promise<CheckResult> {
  try {
    return { id, title, ...(await body()) };
  } catch (err) {
    return {
      id,
      title,
      status: 'fail',
      detail: (err as Error).message.split('\n')[0] ?? 'failed',
      fix: 'See the Swage output for details.',
    };
  }
}

const EXPECTED_TOOLS = ['declare_context', 'stage_edit', 'read_files', 'submit_change_set'];

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(
    await check('node', 'Node.js 22.14 or newer', async () => {
      const r = await deps.run('node', ['--version']);
      if (!r.ok)
        return {
          status: 'fail',
          detail: 'node not found on PATH',
          fix: 'Install Node.js 22.14 or newer and restart VS Code.',
        };
      const v = r.output.trim();
      return nodeAtLeast(v)
        ? { status: 'pass', detail: v }
        : {
            status: 'fail',
            detail: v,
            fix: 'TrueForge needs Node.js 22.14 or newer: upgrade Node.js.',
          };
    }),
  );

  const version = await deps.trueforgeVersion().catch(() => undefined);
  results.push({
    id: 'trueforge',
    title: 'TrueForge reachable',
    ...(version === undefined
      ? {
          status: 'fail' as const,
          detail: `nothing answers at ${deps.trueforgeUrl}`,
          fix: 'Start it with trueforge/start.sh (or enable swage.autoStart), then run Doctor again.',
        }
      : version === deps.pinnedVersion || version === 'unknown'
        ? { status: 'pass' as const, detail: `${version} at ${deps.trueforgeUrl}` }
        : {
            status: 'warn' as const,
            detail: `${version} at ${deps.trueforgeUrl}; Swage is tested on ${deps.pinnedVersion}`,
            fix: `Use the pinned version: trueforge/start.sh runs ${deps.pinnedVersion}.`,
          }),
  });
  const up = version !== undefined;
  const skipped = (id: string, title: string): CheckResult => ({
    id,
    title,
    status: 'skip',
    detail: 'TrueForge is not reachable',
    fix: 'Start TrueForge first.',
  });

  if (up) {
    results.push(
      await check('mcp', 'MCP server reachable with the token', async () => {
        const direct = await deps.mcpDirect();
        const tools = await deps.mcpToolsViaTrueForge();
        const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
        if (!direct.withToken)
          return {
            status: 'fail',
            detail: "Swage's MCP server does not answer",
            fix: 'Reload the window to restart the editor tools.',
          };
        if (!direct.withoutTokenRefused)
          return {
            status: 'fail',
            detail: 'the MCP server answered without the token',
            fix: 'This is a bug: report it; do not record.',
          };
        if (missing.length > 0)
          return {
            status: 'fail',
            detail: `TrueForge sees ${tools.length} tool(s); missing ${missing.join(', ')}`,
            fix: 'Run any Swage request once (it registers editor-tools), or reload the window.',
          };
        return {
          status: 'pass',
          detail: `TrueForge sees ${tools.length} tools; requests without the token get 401`,
        };
      }),
    );
  } else {
    results.push(skipped('mcp', 'MCP server reachable with the token'));
  }

  for (const p of deps.profiles) {
    const title = `Profile ${p.name}: ${p.label} (${p.trueforgeModel})`;
    if (!up) {
      results.push(
        skipped(`agents:${p.name}`, `${title} agents`),
        skipped(`probe:${p.name}`, `${title} tool call`),
      );
      continue;
    }
    let agentsOk = false;
    results.push(
      await check(`agents:${p.name}`, `${title} agents`, async () => {
        try {
          const names = await deps.ensureAgents(p);
          agentsOk = true;
          return { status: 'pass', detail: `present: ${names.join(', ')}` };
        } catch (err) {
          const message = (err as Error).message.split('\n')[0] ?? '';
          return {
            status: 'fail',
            detail: message,
            fix: `Add the model ${p.trueforgeModel} in TrueForge Settings, Models, or change profile ${p.name}.`,
          };
        }
      }),
    );
    if (!agentsOk) {
      results.push({
        id: `probe:${p.name}`,
        title: `${title} tool call`,
        status: 'skip',
        detail: 'no agent',
      });
      continue;
    }
    results.push(
      await check(`probe:${p.name}`, `${title} tool call`, async () => {
        const r = await deps.probe(p);
        if (r.ok) return { status: 'pass', detail: `${r.detail} in ${(r.ms / 1000).toFixed(1)} s` };
        const transient = r.failure?.kind === 'transient';
        return {
          status: transient && p !== deps.profiles[0] ? 'warn' : 'fail',
          detail: r.detail,
          fix: probeFix(p, r.failure, r.detail),
        };
      }),
    );
  }

  results.push(
    await check('ripgrep', 'ripgrep', async () => {
      const r = await deps.run('rg', ['--version']);
      if (r.ok) return { status: 'pass', detail: r.output.split('\n')[0]?.trim() ?? 'rg' };
      if (deps.bundledRipgrep)
        return { status: 'pass', detail: `VS Code's bundled rg (${deps.bundledRipgrep})` };
      return {
        status: 'warn',
        detail: 'rg not found',
        fix: 'Install ripgrep (brew install ripgrep, or your package manager).',
      };
    }),
  );

  let python: string | undefined;
  results.push(
    await check('python', 'Python', async () => {
      for (const candidate of deps.pythonCandidates) {
        const r = await deps.run(candidate, ['--version']);
        if (r.ok) {
          python = candidate;
          return { status: 'pass', detail: `${r.output.trim()} (${candidate})` };
        }
      }
      return {
        status: 'fail',
        detail: 'no Python found',
        fix: 'Install Python 3 and create the workspace venv: python3 -m venv .venv',
      };
    }),
  );
  results.push(
    await check('pytest', 'pytest', async () => {
      if (!python) return { status: 'skip', detail: 'no Python' };
      const r = await deps.run(python, ['-m', 'pytest', '--version']);
      return r.ok
        ? { status: 'pass', detail: r.output.trim().split('\n')[0] ?? 'pytest' }
        : {
            status: 'fail',
            detail: `pytest is not installed for ${python}`,
            fix: `${python} -m pip install pytest (Flask 3.1.3 needs pytest 9.0.2: see docs/SPIKES.md).`,
          };
    }),
  );
  results.push({
    id: 'trust',
    title: 'Workspace trusted',
    ...(deps.workspaceTrusted
      ? { status: 'pass' as const, detail: 'trusted' }
      : {
          status: 'fail' as const,
          detail: 'Restricted Mode',
          fix: 'Run "Workspaces: Manage Workspace Trust" and trust this folder.',
        }),
  });
  return results;
}

const ICON: Record<CheckStatus, string> = {
  pass: '✅ pass',
  warn: '⚠️ warn',
  fail: '❌ fail',
  skip: '⏭ skip',
};

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function summary(results: readonly CheckResult[]): string {
  const n = (s: CheckStatus): number => results.filter((r) => r.status === s).length;
  return `${n('pass')} passed, ${n('fail')} failed, ${n('warn')} warning(s), ${n('skip')} skipped`;
}

/** The report as a Markdown table, one row per check, with the fix for each problem. */
export function doctorMarkdown(results: readonly CheckResult[], when = new Date()): string {
  const rows = results.map(
    (r) =>
      `| ${cell(r.title)} | ${ICON[r.status]} | ${cell(r.detail)} | ${cell(r.status === 'pass' ? '' : (r.fix ?? ''))} |`,
  );
  return [
    '# Swage: Doctor',
    '',
    `${summary(results)} · ${when.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '',
    '| Check | Result | Details | Fix |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
