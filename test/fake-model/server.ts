import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { FINAL_TEXT, type Scenario, type ScenarioStep } from './scenario';

/**
 * An OpenAI-compatible chat-completions server that plays scenarios. The request's `model` is
 * the scenario name. Supports SSE streaming and non-streaming replies, text deltas, tool calls,
 * delays, a stall, HTTP 401, 429 and 500, a dropped connection and a hang. Binds 127.0.0.1 only.
 */

export interface FakeModelRequest {
  readonly model: string;
  readonly step: number;
  readonly stream: boolean;
  readonly toolNames: readonly string[];
}

export interface FakeModel {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: FakeModelRequest[];
  stop(): Promise<void>;
}

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: { role?: string }[];
  tools?: { function?: { name?: string } }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chunk(
  res: ServerResponse,
  model: string,
  delta: object,
  finish: string | null,
  usage?: object,
): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`,
  );
}

function toolCallsOf(
  step: ScenarioStep,
  stepIndex: number,
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  return (step.toolCalls ?? []).map((tc, i) => ({
    id: `call_${stepIndex}_${i}`,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }));
}

export async function startFakeModel(options: {
  scenarios: readonly Scenario[];
  port?: number;
}): Promise<FakeModel> {
  const scenarios = new Map(options.scenarios.map((s) => [s.name, s]));
  const requests: FakeModelRequest[] = [];
  const attempts = new Map<string, number>();
  const sockets = new Set<Socket>();

  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += String(c)));
    req.on('end', () => {
      void (async () => {
        const url = req.url ?? '';
        if (req.method === 'GET' && url.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              object: 'list',
              data: [...scenarios.keys()].map((id) => ({
                id,
                object: 'model',
                owned_by: 'swage-fake',
              })),
            }),
          );
          return;
        }
        if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end('{"error":{"message":"not found"}}');
          return;
        }
        const body = (raw ? JSON.parse(raw) : {}) as ChatBody;
        const model = body.model ?? '';
        const scenario = scenarios.get(model);
        if (!scenario) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: {
                message: `The model \`${model}\` does not exist`,
                type: 'invalid_request_error',
                code: 'model_not_found',
              },
            }),
          );
          return;
        }
        const stepIndex = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
        const step: ScenarioStep = scenario.steps[stepIndex] ?? { text: [FINAL_TEXT] };
        requests.push({
          model,
          step: stepIndex,
          stream: body.stream === true,
          toolNames: (body.tools ?? []).map((t) => t.function?.name ?? ''),
        });

        const key = `${model}#${stepIndex}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const failing =
          step.error !== undefined && (step.errorTimes === undefined || attempt <= step.errorTimes);
        if (failing) {
          if (step.error === 'hang') return;
          if (step.error === 'refused') {
            req.socket.destroy();
            return;
          }
          const status = step.error as number;
          res
            .writeHead(status, {
              'content-type': 'application/json',
              ...(status === 429 ? { 'retry-after': '1' } : {}),
            })
            .end(
              JSON.stringify({
                error:
                  status === 429
                    ? {
                        message: 'Rate limit reached for requests. Please try again in 1s.',
                        type: 'rate_limit_exceeded',
                        code: 'rate_limit_exceeded',
                      }
                    : status === 401
                      ? {
                          // OpenAI's body for a bad key (no key is involved: this is a fake).
                          message: 'Invalid API Key',
                          type: 'invalid_request_error',
                          code: 'invalid_api_key',
                        }
                      : {
                          message: 'The server had an error while processing your request.',
                          type: 'server_error',
                        },
              }),
            );
          return;
        }

        const calls = toolCallsOf(step, stepIndex);
        const text = step.text ?? [];
        const usage = {
          prompt_tokens: 100,
          completion_tokens: 10 * (text.length + calls.length),
          total_tokens: 100 + 10 * (text.length + calls.length),
        };
        if (step.firstTokenDelayMs) await sleep(step.firstTokenDelayMs);

        if (body.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: 'chatcmpl-fake',
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: text.join('') || null,
                    ...(calls.length ? { tool_calls: calls } : {}),
                  },
                  finish_reason: calls.length ? 'tool_calls' : 'stop',
                },
              ],
              usage,
            }),
          );
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let sent = 0;
        const pace = async (): Promise<void> => {
          sent++;
          if (step.stallAfterChunks !== undefined && sent === step.stallAfterChunks)
            await sleep(step.stallMs ?? 60_000);
          else if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
        };
        chunk(res, model, { role: 'assistant', content: '' }, null);
        for (const piece of text) {
          if (res.destroyed) return;
          chunk(res, model, { content: piece }, null);
          await pace();
        }
        for (const [i, call] of calls.entries()) {
          if (res.destroyed) return;
          chunk(res, model, { tool_calls: [{ index: i, ...call }] }, null);
          await pace();
        }
        chunk(res, model, {}, calls.length ? 'tool_calls' : 'stop', usage);
        res.end('data: [DONE]\n\n');
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  http.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        http.close(() => resolve());
      }),
  };
}
