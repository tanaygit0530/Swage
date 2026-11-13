import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentRun, type AgentRunOptions, type AgentView } from '../../src/agent/run';
import { EventRelay } from '../../src/agent/relay';
import { SwageClient } from '../../src/client/client';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { ApprovalList, createToolContext, type ToolContext } from '../../src/mcp/context';
import { startEditorToolsServer, type EditorToolsServer } from '../../src/mcp/server';
import { EDITOR_TOOLS } from '../../src/mcp/tools/index';
import type { HostToWebview } from '../../src/ui/protocol';
import { editRange, type InlineRequest, type LineRange } from '../../src/inline/context';
import { InlineEdit } from '../../src/inline/run';
import { readFileSync } from 'node:fs';
import { loadScenarios, type Scenario } from '../fake-model/scenario';
import { FakeTrueForge, type FakeTrueForgeOptions } from './fakeTrueForge';

export const DEMO = path.join(__dirname, '..', 'fake-model', 'demo');
const scenarios = new Map(loadScenarios().map((s) => [s.name, s]));

export interface AgentHarness {
  readonly root: string;
  readonly ctx: ToolContext;
  readonly server: EditorToolsServer;
  readonly fake: FakeTrueForge;
  readonly run: AgentRun;
  readonly posts: HostToWebview[];
  readonly logs: string[];
  close(): Promise<void>;
}

/** Copies the demo workspace, starts the real MCP server, and wires an AgentRun to a scripted TrueForge. */
export async function startAgent(
  scenario: string | Scenario,
  options: Partial<Omit<FakeTrueForgeOptions, 'scenario' | 'mcp'>> = {},
  runOptions: Partial<AgentRunOptions> = {},
): Promise<AgentHarness> {
  const script = typeof scenario === 'string' ? scenarios.get(scenario) : scenario;
  if (!script) throw new Error(`unknown scenario ${String(scenario)}`);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-agent-')));
  cpSync(DEMO, root, { recursive: true });
  const index = new WorkspaceIndex({ root, parser: await createParser(), cache: null });
  await index.build();
  const relay = new EventRelay();
  const approvals = new ApprovalList();
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const ctx = createToolContext({
    root,
    index,
    searcher: new Bm25Searcher(index),
    events: relay,
    approvals,
    logger,
  });
  const server = await startEditorToolsServer({ context: ctx, tools: EDITOR_TOOLS });
  const fake = new FakeTrueForge({
    scenario: script,
    mcp: { url: server.url, token: server.token },
    ...options,
  });
  const posts: HostToWebview[] = [];
  const view: AgentView = { post: (m) => posts.push(m) };
  const run = new AgentRun({
    client: new SwageClient({ baseUrl: 'http://fake', sdk: fake.sdk }),
    ctx,
    relay,
    approvals,
    agentName: 'swage-main-fake',
    view,
    logger,
    drainTimeoutMs: 20_000,
    ...runOptions,
  });
  return {
    root,
    ctx,
    server,
    fake,
    run,
    posts,
    logs,
    close: async () => {
      await fake.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface InlineHarness extends Omit<AgentHarness, 'run'> {
  readonly edit: InlineEdit;
  readonly statuses: string[];
  readonly request: InlineRequest;
}

/**
 * An inline edit on the demo workspace: `range` (1-based lines) or, without it, the function
 * around `cursorLine`, exactly as the editor command picks it.
 */
export async function startInline(
  scenario: string | Scenario,
  target: { path: string; instruction: string; range?: LineRange; cursorLine?: number },
): Promise<InlineHarness> {
  const base = await startAgent(scenario);
  const text = readFileSync(path.join(base.root, target.path), 'utf8');
  const symbols = base.ctx.index.get(target.path)?.symbols ?? [];
  const range =
    target.range ??
    editRange(symbols, {
      startLine: target.cursorLine ?? 1,
      endLine: target.cursorLine ?? 1,
      endCharacter: 0,
      empty: true,
    });
  const request: InlineRequest = {
    instruction: target.instruction,
    path: target.path,
    text,
    range,
    symbols,
    language: 'python',
  };
  const statuses: string[] = [];
  const edit = new InlineEdit({
    client: new SwageClient({ baseUrl: 'http://fake', sdk: base.fake.sdk }),
    ctx: base.ctx,
    relay: new EventRelay(),
    approvals: new ApprovalList(),
    agentName: 'swage-inline-fake',
    request,
    onStatus: (t) => statuses.push(t),
    drainTimeoutMs: 20_000,
  });
  const { run: _unused, ...rest } = base;
  void _unused;
  return { ...rest, edit, statuses, request };
}
