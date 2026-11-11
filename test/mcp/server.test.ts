import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runTool, textResult, ToolError, type ToolContext } from '../../src/mcp/context';
import { buildMcpServer, type ToolRegistration } from '../../src/mcp/server';
import { startHarness, type Harness } from './harness';

/** A probe tool that exercises runTool: echo, a ToolError, a crash, a secret, a slow call. */
const probe: ToolRegistration = (server, ctx: ToolContext) => {
  server.registerTool(
    'probe',
    { description: 'test probe', inputSchema: { mode: z.string(), ms: z.number().optional() } },
    runTool(ctx, 'probe', async ({ mode, ms }: { mode: string; ms?: number | undefined }, call) => {
      if (mode === 'tool-error')
        throw new ToolError('bad_input', 'Mode is wrong; use echo.', { hint: 'echo' });
      if (mode === 'crash') throw new Error('kaboom');
      if (mode === 'secret') return textResult(`key gs${'k_'}A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6`);
      if (mode === 'slow') {
        await new Promise((r) => setTimeout(r, ms ?? 50));
        call.signal.throwIfAborted();
      }
      return textResult(`echo ${mode} for ${call.task.id}`);
    }),
  );
};

let h: Harness;

beforeAll(async () => {
  h = await startHarness([probe], { files: { 'a.py': 'x = 1\n' } });
});

afterAll(async () => {
  await h.close();
});

/** Sends a raw request and resolves with the status (and a short body for small JSON replies). */
function raw(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request(
      url,
      { method: init.method ?? 'POST', headers: init.headers ?? {} },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 401 && status !== 403) {
          // Only the auth checks need the body; a 200 is an SSE stream that stays open.
          res.destroy();
          resolve({ status, body: '' });
          return;
        }
        let body = '';
        res.on('data', (c: Buffer) => (body += String(c)));
        res.on('end', () => resolve({ status, body }));
      },
    );
    // The server may answer 413 before the upload finishes and close the socket.
    req.on('error', () => undefined);
    req.end(init.body);
  });
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'x', version: '0' },
  },
});
const jsonHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('MCP server security', () => {
  it('listens on 127.0.0.1 with a random port and a 64-hex-character token', () => {
    expect(h.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(h.server.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects requests without the bearer token, or with a wrong one, with 401', async () => {
    for (const headers of [
      jsonHeaders,
      { ...jsonHeaders, authorization: 'Bearer wrong' },
      { ...jsonHeaders, authorization: h.server.token },
      { ...jsonHeaders, authorization: `Bearer ${h.server.token}x` },
    ]) {
      const r = await raw(h.server.url, { headers, body: initBody });
      expect(r.status).toBe(401);
      expect(r.body).toBe('{"error":"unauthorized"}');
    }
  });

  it('rejects a foreign Host header with 403 even with the right token', async () => {
    const r = await raw(h.server.url, {
      headers: {
        ...jsonHeaders,
        authorization: `Bearer ${h.server.token}`,
        host: 'evil.example:80',
      },
      body: initBody,
    });
    expect(r.status).toBe(403);
  });

  it('serves only POST /mcp and limits the body size', async () => {
    const auth = { ...jsonHeaders, authorization: `Bearer ${h.server.token}` };
    expect(
      (await raw(h.server.url.replace('/mcp', '/other'), { headers: auth, body: initBody })).status,
    ).toBe(404);
    expect((await raw(h.server.url, { method: 'GET', headers: auth })).status).toBe(405);
    expect((await raw(h.server.url, { headers: auth, body: '{not json' })).status).toBe(400);
    expect(
      (await raw(h.server.url, { headers: auth, body: 'x'.repeat(5 * 1024 * 1024) })).status,
    ).toBe(413);
    expect((await raw(h.server.url, { headers: auth, body: initBody })).status).toBe(200);
  });

  it('answers through a real MCP client with the token', async () => {
    const tools = await h.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['probe']);
  });
});

describe('runTool rules', () => {
  it('requires an active task', async () => {
    const r = await h.call('probe', { mode: 'echo' });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('no_active_task');
  });

  it('runs inside the task, logs timing, and returns structured errors', async () => {
    h.ctx.tasks.start('task-1', 'turn-1');
    expect(h.text(await h.call('probe', { mode: 'echo' }))).toBe('echo echo for task-1');
    const err = await h.call('probe', { mode: 'tool-error' });
    expect(err.isError).toBe(true);
    expect(JSON.parse(h.text(err))).toEqual({
      error: { code: 'bad_input', message: 'Mode is wrong; use echo.', hint: 'echo' },
    });
    const crash = await h.call('probe', { mode: 'crash' });
    expect(JSON.parse(h.text(crash)).error).toEqual({
      code: 'internal_error',
      message: 'Swage could not complete probe: kaboom',
    });
    expect(h.logs.some((l) => /^tool probe \d+ ms ok$/.test(l))).toBe(true);
    expect(h.logs.some((l) => /^tool probe \d+ ms bad_input$/.test(l))).toBe(true);
  });

  it('redacts every result', async () => {
    h.ctx.tasks.start('task-1');
    const r = h.text(await h.call('probe', { mode: 'secret' }));
    expect(r).toBe('key [REDACTED:groq_key]');
  });

  it('discards a late result when the task is cancelled mid-call', async () => {
    h.ctx.tasks.start('task-2', 'turn-a');
    const pending = h.call('probe', { mode: 'slow', ms: 100 });
    setTimeout(() => h.ctx.tasks.cancel('task-2'), 20);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(JSON.parse(h.text(r)).error.code).toBe('cancelled');
  });

  it('discards a result whose turn changed while it ran', async () => {
    h.ctx.tasks.start('task-3', 'turn-a');
    const pending = h.call('probe', { mode: 'slow', ms: 60 });
    setTimeout(() => h.ctx.tasks.setTurn('task-3', 'turn-b'), 10);
    expect(JSON.parse(h.text(await pending)).error.code).toBe('cancelled');
    expect(h.text(await h.call('probe', { mode: 'echo' }))).toBe('echo echo for task-3');
  });
});

describe('task registry', () => {
  it('starting a new task cancels the previous one and discards its change set', () => {
    const a = h.ctx.tasks.start('a');
    const b = h.ctx.tasks.start('b');
    expect(a.cancelled).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
    expect(a.changeSet.status).toBe('discarded');
    expect(h.ctx.tasks.current()).toBe(b);
    expect(h.ctx.tasks.start('b', 'turn-9')).toBe(b);
    expect(b.turnId).toBe('turn-9');
    h.ctx.tasks.finish('b');
    expect(h.ctx.tasks.current()).toBeUndefined();
    expect(h.ctx.tasks.get('a')?.cancelled).toBe(true);
    h.ctx.tasks.cancel('missing');
  });

  it('buildMcpServer registers the given tools', () => {
    expect(buildMcpServer(h.ctx, [probe])).toBeDefined();
  });
});
