/**
 * A tiny OpenAI-compatible endpoint on 127.0.0.1 for the spikes (blueprint section 11:
 * "a scripted fake model"). TrueForge reaches it as a custom provider, so nothing leaves
 * this machine and no real key is involved.
 *
 * Modes:
 * - `tool-then-text`: the first request answers with a call to the tool whose name ends in
 *   `toolSuffix`, later requests answer with text.
 * - `text`: always answers "hello from the fake model".
 * - `unauthorized`: HTTP 401 with OpenAI's invalid-key error body.
 * - `hang`: accepts the request and never answers.
 */
import { createServer, type ServerResponse } from 'node:http';

export type FakeMode = 'tool-then-text' | 'text' | 'unauthorized' | 'hang';

export interface FakeOpenAi {
  readonly baseUrl: string;
  /** Bodies of every chat completion request received. */
  readonly requests: {
    model?: string;
    stream?: boolean;
    tools?: { function?: { name?: string } }[];
  }[];
  stop(): Promise<void>;
}

function sseChunk(res: ServerResponse, delta: object, finish: string | null, usage?: object): void {
  const chunk = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function startFakeOpenAi(
  mode: FakeMode,
  options: { toolSuffix?: string } = {},
): Promise<FakeOpenAi> {
  const requests: FakeOpenAi['requests'] = [];
  const toolSuffix = options.toolSuffix ?? 'read_files';

  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += String(c)));
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end('{"error":{"message":"not found"}}');
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as FakeOpenAi['requests'][number];
      requests.push(body);

      if (mode === 'hang') return; // Never answer.
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: {
              message: 'Invalid API Key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
        );
        return;
      }

      const tool = body.tools
        ?.map((t) => t.function?.name ?? '')
        .find((n) => n.endsWith(toolSuffix));
      const callTool = mode === 'tool-then-text' && requests.length === 1 && tool !== undefined;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

      if (body.stream !== true) {
        const message = callTool
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_fake_1',
                  type: 'function',
                  function: { name: tool, arguments: '{"paths":["README.md"]}' },
                },
              ],
            }
          : { role: 'assistant', content: 'hello from the fake model' };
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'fake',
            choices: [{ index: 0, message, finish_reason: callTool ? 'tool_calls' : 'stop' }],
            usage,
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (callTool) {
        sseChunk(
          res,
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_fake_1',
                type: 'function',
                function: { name: tool, arguments: '{"paths":["README.md"]}' },
              },
            ],
          },
          null,
        );
        sseChunk(res, {}, 'tool_calls', usage);
      } else {
        sseChunk(res, { role: 'assistant', content: 'hello ' }, null);
        sseChunk(res, { content: 'from the fake model' }, null);
        sseChunk(res, {}, 'stop', usage);
      }
      res.end('data: [DONE]\n\n');
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
