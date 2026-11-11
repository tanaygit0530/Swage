import { parseProfilesText, type ResolvedProfile } from '../resilience/profiles';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describeError, type SwageClient } from './client';
import {
  agentNameFor,
  parseManifest,
  withProfile,
  type AgentSpec,
  type ModelProfile,
} from './manifest';

/**
 * Idempotent setup (blueprint section 9, step 5): register the editor-tools MCP server, then
 * create or update one main and one inline agent per model profile. Safe to run repeatedly:
 * MCP registration uses PUT (create or replace by name) and agents are upserted by exact name.
 */

export const MCP_SERVER_NAME = 'editor-tools';
export const MCP_SERVER_DESCRIPTION =
  'Swage editor tools: search and read the workspace, declare context, stage edits for review and run tests from VS Code.';

export const AGENTS = [
  {
    base: 'swage-main',
    file: 'main.agent.json',
    description: 'Swage agent mode: multi-file changes reviewed in VS Code.',
  },
  {
    base: 'swage-inline',
    file: 'inline.agent.json',
    description: 'Swage inline edit: one selection, reviewed in VS Code.',
  },
] as const;

export interface Manifests {
  readonly 'swage-main': AgentSpec;
  readonly 'swage-inline': AgentSpec;
}

export interface SetupOptions {
  readonly client: SwageClient;
  readonly profiles: readonly ModelProfile[];
  readonly manifests: Manifests;
  /** Omit to skip MCP registration (for example before the extension's server exists). */
  readonly mcp?: { readonly url: string; readonly bearerToken: string };
}

export interface AgentResult {
  readonly name: string;
  readonly profile: string;
  readonly model: string;
  readonly result: 'created' | 'updated' | 'error';
  readonly id?: string;
  readonly error?: string;
}

export interface SetupReport {
  readonly mcp: {
    readonly status: 'registered' | 'skipped' | 'error';
    readonly tools?: readonly string[];
    readonly error?: string;
  };
  readonly missingModels: readonly string[];
  readonly agents: readonly AgentResult[];
}

export function loadManifests(dir: string): Manifests {
  const read = (file: string): AgentSpec =>
    parseManifest(readFileSync(path.join(dir, file), 'utf8'), file);
  return { 'swage-main': read('main.agent.json'), 'swage-inline': read('inline.agent.json') };
}

/** Parses a profiles file (YAML or JSON): validated, with timeouts filled from the kind. */
export function parseProfiles(text: string, source = 'profiles'): ResolvedProfile[] {
  return parseProfilesText(text, source);
}

export async function runSetup(options: SetupOptions): Promise<SetupReport> {
  const { client } = options;
  const available = new Set(await client.listModels());
  const missingModels = [...new Set(options.profiles.map((p) => p.trueforgeModel))].filter(
    (m) => !available.has(m),
  );

  let mcp: SetupReport['mcp'] = { status: 'skipped' };
  if (options.mcp) {
    try {
      await client.registerMcpServer({
        name: MCP_SERVER_NAME,
        url: options.mcp.url,
        description: MCP_SERVER_DESCRIPTION,
        bearerToken: options.mcp.bearerToken,
      });
      let tools: string[] | undefined;
      try {
        tools = await client.listMcpTools(MCP_SERVER_NAME);
      } catch {
        tools = undefined;
      }
      mcp = { status: 'registered', ...(tools ? { tools } : {}) };
    } catch (err) {
      mcp = { status: 'error', error: describeError(err) };
    }
  }

  const agents: AgentResult[] = [];
  for (const profile of options.profiles) {
    for (const agent of AGENTS) {
      const name = agentNameFor(agent.base, profile);
      try {
        const spec = withProfile(options.manifests[agent.base], profile);
        const { id, created } = await client.upsertAgent(name, agent.description, spec);
        agents.push({
          name,
          profile: profile.name,
          model: profile.trueforgeModel,
          result: created ? 'created' : 'updated',
          id,
        });
      } catch (err) {
        agents.push({
          name,
          profile: profile.name,
          model: profile.trueforgeModel,
          result: 'error',
          error: describeError(err),
        });
      }
    }
  }
  return { mcp, missingModels, agents };
}

/** Human-readable report lines. Never includes the bearer token. */
export function formatReport(report: SetupReport): string[] {
  const lines: string[] = [];
  if (report.mcp.status === 'registered') {
    lines.push(
      `MCP server ${MCP_SERVER_NAME}: registered${report.mcp.tools ? ` (${report.mcp.tools.length} tools: ${report.mcp.tools.join(', ')})` : ''}`,
    );
  } else if (report.mcp.status === 'error') {
    lines.push(`MCP server ${MCP_SERVER_NAME}: FAILED (${report.mcp.error ?? 'unknown error'})`);
  } else {
    lines.push(
      `MCP server ${MCP_SERVER_NAME}: skipped (set SWAGE_MCP_URL and SWAGE_MCP_TOKEN to register it)`,
    );
  }
  for (const m of report.missingModels) {
    lines.push(`Model ${m} is not configured in TrueForge (Settings, Models).`);
  }
  for (const a of report.agents) {
    lines.push(`Agent ${a.name} (${a.model}): ${a.result}${a.error ? ` (${a.error})` : ''}`);
  }
  return lines;
}

/**
 * Makes sure a profile's agent exists with the profile's model before a session is opened on it
 * (fallback profiles are prepared on first use). Cached per agent name and model, so a changed
 * primary model is pushed again; a failure is not cached, so the next attempt retries.
 */
export function agentPreparer(
  client: SwageClient,
  manifests: Manifests,
): (profile: ModelProfile, agentName: string) => Promise<void> {
  const done = new Map<string, Promise<void>>();
  return (profile, agentName) => {
    const agent = AGENTS.find((a) => agentName.startsWith(`${a.base}-`));
    if (!agent) return Promise.reject(new Error(`No manifest for agent ${agentName}`));
    const key = `${agentName}@${profile.trueforgeModel}`;
    let pending = done.get(key);
    if (!pending) {
      pending = client
        .upsertAgent(agentName, agent.description, withProfile(manifests[agent.base], profile))
        .then(() => undefined);
      done.set(key, pending);
      pending.catch(() => done.delete(key));
    }
    return pending;
  };
}
