/**
 * A minimal MCP server for the spikes: streamable HTTP, stateless, bearer-token auth,
 * using the official @modelcontextprotocol/sdk. It exposes two harmless read-only tools.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface StubMcp {
  readonly url: string;
  /** Tool calls received, in order. */
  readonly calls: { tool: string; args: unknown }[];
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body === '' ? undefined : JSON.parse(body);
}

export async function startStubMcp(options: { token: string; port?: number }): Promise<StubMcp> {
  const calls: { tool: string; args: unknown }[] = [];
  const build = (): McpServer => {
    const server = new McpServer({ name: 'swage-spike-tools', version: '0.0.1' });
    server.registerTool(
      'read_files',
      {
        description: 'Read one or more workspace files and return their text.',
        inputSchema: { paths: z.array(z.string()).describe('Workspace-relative file paths') },
        annotations: { readOnlyHint: true },
      },
      ({ paths }) => {
        calls.push({ tool: 'read_files', args: { paths } });
        return {
          content: [
            { type: 'text', text: paths.map((p) => `# ${p}\nSwage spike file ${p}.`).join('\n') },
          ],
        };
      },
    );
    server.registerTool(
      'find_relevant_code',
      {
        description: 'Search the workspace for code relevant to a query.',
        inputSchema: { query: z.string().describe('What to look for') },
        annotations: { readOnlyHint: true },
      },
      ({ query }) => {
        calls.push({ tool: 'find_relevant_code', args: { query } });
        return {
          content: [{ type: 'text', text: `No matches for ${query} in the spike workspace.` }],
        };
      },
    );
    return server;
  };

  const http = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401).end();
        return;
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      const server = build();
      // Stateless mode: no session-id generator.
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(
        req,
        res,
        req.method === 'POST' ? await readBody(req) : undefined,
      );
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
