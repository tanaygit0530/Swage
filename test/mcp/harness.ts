import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { createToolContext, type ContextOptions, type ToolContext } from '../../src/mcp/context';
import {
  startEditorToolsServer,
  type EditorToolsServer,
  type ToolRegistration,
} from '../../src/mcp/server';

export const FIXTURE = path.join(__dirname, '..', 'retrieval-eval', 'fixture');

export interface Harness {
  readonly root: string;
  readonly ctx: ToolContext;
  readonly server: EditorToolsServer;
  readonly client: Client;
  readonly logs: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  text(result: CallToolResult): string;
  close(): Promise<void>;
}

/** Copies the fixture (or writes `files`) into a temp workspace and starts the server with `tools`. */
export async function startHarness(
  tools: readonly ToolRegistration[],
  options: { files?: Record<string, string>; context?: Partial<ContextOptions> } = {},
): Promise<Harness> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-mcp-')));
  if (options.files) {
    for (const [rel, content] of Object.entries(options.files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
  } else {
    cpSync(FIXTURE, root, { recursive: true });
  }
  const index = new WorkspaceIndex({ root, parser: await createParser(), cache: null });
  await index.build();
  const logs: string[] = [];
  const ctx = createToolContext({
    root,
    index,
    searcher: new Bm25Searcher(index),
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...options.context,
  });
  const server = await startEditorToolsServer({ context: ctx, tools });
  const client = new Client({ name: 'swage-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const text = (r: CallToolResult): string =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return {
    root,
    ctx,
    server,
    client,
    logs,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    text,
    close: async () => {
      await client.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Hash of every file under `root` (except `.swage`), to prove a tool wrote nothing. */
export function treeHash(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.swage') continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else h.update(`${path.relative(root, abs)}\0`).update(readFileSync(abs));
    }
  };
  walk(root);
  return h.digest('hex');
}
