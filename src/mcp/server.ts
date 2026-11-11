import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolContext } from './context';

/**
 * Swage's local MCP server (blueprint section 6): Streamable HTTP on 127.0.0.1 only, a random
 * port and a random bearer token. Every request without the exact token gets 401, and a Host
 * header other than 127.0.0.1 or localhost gets 403 (DNS-rebinding defence). Stateless mode:
 * a fresh MCP server per request, which the issue 878 retest showed TrueForge handles cleanly.
 */

/** Registers one tool on a per-request MCP server. */
export type ToolRegistration = (server: McpServer, ctx: ToolContext) => void;

export interface EditorToolsServer {
  /** `http://127.0.0.1:<port>/mcp`, the URL registered in TrueForge. */
  readonly url: string;
  readonly port: number;
  /** Bearer token; pass it to TrueForge once, never log it. */
  readonly token: string;
  stop(): Promise<void>;
}

export interface ServerOptions {
  readonly context: ToolContext;
  readonly tools: readonly ToolRegistration[];
  /** 0 picks a free port. */
  readonly port?: number;
  /** Supply a token for tests; the default is 32 random bytes. */
  readonly token?: string;
  /** Request body limit, default 4 MB. */
  readonly maxBodyBytes?: number;
}

export const SERVER_NAME = 'swage-editor-tools';

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

export function buildMcpServer(ctx: ToolContext, tools: readonly ToolRegistration[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '0.0.1' });
  for (const register of tools) register(server, ctx);
  return server;
}

export async function startEditorToolsServer(options: ServerOptions): Promise<EditorToolsServer> {
  const token = options.token ?? randomBytes(32).toString('hex');
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const { context: ctx } = options;
  let port = 0;

  const http: Server = createServer((req, res) => {
    void (async () => {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res
          .writeHead(403, { 'content-type': 'application/json' })
          .end('{"error":"forbidden host"}');
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        res
          .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
          .end('{"error":"unauthorized"}');
        return;
      }
      if (req.url !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      if (req.method !== 'POST') {
        // Stateless server: no server-initiated SSE stream and no sessions to delete.
        res
          .writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
          .end('{"error":"method not allowed"}');
        return;
      }
      let body: unknown;
      try {
        body = await readJson(req, limit);
      } catch (err) {
        const tooLarge = (err as Error).message === 'payload too large';
        res
          .writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: (err as Error).message }));
        return;
      }
      const server = buildMcpServer(ctx, options.tools);
      // Stateless mode: no session-id generator.
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      ctx.logger.error(`MCP request failed: ${(err as Error).message}`);
      if (!res.headersSent)
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end('{"error":"internal error"}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  port = typeof address === 'object' && address ? address.port : 0;
  ctx.logger.info(`MCP server listening on http://127.0.0.1:${port}/mcp`);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    token,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
