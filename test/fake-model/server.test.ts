import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenarios, parseScenario, type Scenario } from './scenario';
import { startFakeModel, type FakeModel } from './server';

const DEMO = path.join(__dirname, 'demo');
const scenarios = loadScenarios();
const extra: Scenario[] = [
  {
    name: 'two-steps',
    steps: [
      {
        text: ['a', 'b'],
        toolCalls: [{ name: 'read_files', arguments: { files: [{ path: 'x' }] } }],
      },
      { text: ['second'] },
    ],
  },
  { name: 'slow-first', steps: [{ firstTokenDelayMs: 300, text: ['late'] }] },
];

let fake: FakeModel;
beforeAll(async () => {
  fake = await startFakeModel({ scenarios: [...scenarios, ...extra] });
});
afterAll(() => fake.stop());

interface Delta {
  content?: string;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

async function stream(
  model: string,
  assistantTurns = 0,
  signal?: AbortSignal,
): Promise<{ deltas: Delta[]; finish: string | null; times: number[] }> {
  const t0 = Date.now();
  const res = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'user', content: 'hi' },
        ...Array.from({ length: assistantTurns }, () => ({ role: 'assistant', content: 'x' })),
      ],
      tools: [{ type: 'function', function: { name: 'read_files' } }],
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const deltas: Delta[] = [];
  const times: number[] = [];
  let finish: string | null = null;
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const c = JSON.parse(line.slice(6)) as {
      choices: { delta: Delta; finish_reason: string | null }[];
    };
    deltas.push(c.choices[0]?.delta ?? {});
    finish = c.choices[0]?.finish_reason ?? finish;
  }
  times.push(Date.now() - t0);
  return { deltas, finish, times };
}

describe('scenarios', () => {
  it('all parse and have unique, TrueForge-safe names', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(new Set(scenarios.map((s) => s.name)).size).toBe(scenarios.length);
  });

  it('every find anchor matches its demo file exactly once', () => {
    let anchors = 0;
    for (const s of scenarios) {
      for (const step of s.steps) {
        for (const call of step.toolCalls ?? []) {
          if (call.name !== 'stage_edit') continue;
          const file = readFileSync(path.join(DEMO, String(call.arguments['path'])), 'utf8');
          for (const edit of (call.arguments['edits'] as { find: string }[] | undefined) ?? []) {
            expect(file.split(edit.find).length - 1, `${s.name}: ${edit.find}`).toBe(1);
            anchors++;
          }
        }
      }
    }
    expect(anchors).toBeGreaterThanOrEqual(5);
  });

  it('rejects malformed scenarios', () => {
    expect(() => parseScenario('{"name":"Bad Name","steps":[{}]}', 'bad.json')).toThrow(
      /bad\.json: name/,
    );
    expect(() => parseScenario('{"name":"ok","steps":[{"error":404}]}')).toThrow(/error/);
    expect(() => parseScenario('{"name":"ok","steps":[{"txt":["x"]}]}')).toThrow();
  });
});

describe('fake model server', () => {
  it('lists the scenarios as models', async () => {
    const r = (await (await fetch(`${fake.baseUrl}/models`)).json()) as { data: { id: string }[] };
    expect(r.data.map((m) => m.id)).toContain('three-file-edit');
  });

  it('streams text deltas and tool calls as OpenAI chunks, choosing the step by assistant turns', async () => {
    const first = await stream('two-steps', 0);
    expect(first.deltas.map((d) => d.content ?? '').join('')).toBe('ab');
    const tc = first.deltas.find((d) => d.tool_calls)?.tool_calls?.[0];
    expect(tc).toEqual({
      index: 0,
      id: 'call_0_0',
      type: 'function',
      function: { name: 'read_files', arguments: '{"files":[{"path":"x"}]}' },
    });
    expect(first.finish).toBe('tool_calls');
    const second = await stream('two-steps', 1);
    expect(second.deltas.map((d) => d.content ?? '').join('')).toBe('second');
    expect(second.finish).toBe('stop');
    const done = await stream('two-steps', 2);
    expect(done.deltas.map((d) => d.content ?? '').join('')).toBe('Done.');
  });

  it('answers non-streaming requests', async () => {
    const res = await fetch(`${fake.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'two-steps', messages: [] }),
    });
    const body = (await res.json()) as {
      choices: { message: { content: string; tool_calls: unknown[] }; finish_reason: string }[];
    };
    expect(body.choices[0]?.message.content).toBe('ab');
    expect(body.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('honours delays and a stall', async () => {
    const slow = await stream('slow-first');
    expect(slow.times[0]).toBeGreaterThanOrEqual(280);
    const t0 = Date.now();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    await expect(stream('stall', 0, controller.signal)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('returns 429 with Retry-After and 500 with OpenAI error bodies', async () => {
    await expect(stream('rate-limit')).rejects.toThrow(/HTTP 429: .*Rate limit reached/);
    await expect(stream('server-error')).rejects.toThrow(/HTTP 500: .*server had an error/);
    const res = await fetch(`${fake.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'rate-limit', messages: [] }),
    });
    expect(res.headers.get('retry-after')).toBe('1');
  });

  it('fails only the first attempts when errorTimes is set', async () => {
    await expect(stream('flaky')).rejects.toThrow(/429/);
    const ok = await stream('flaky');
    expect(ok.deltas.map((d) => d.content ?? '').join('')).toBe('Recovered after a retry.');
  });

  it('drops the connection, hangs, and rejects unknown models', async () => {
    await expect(stream('refused')).rejects.toThrow();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(stream('hang', 0, controller.signal)).rejects.toThrow();
    await expect(stream('nope')).rejects.toThrow(/HTTP 404: .*does not exist/);
    expect((await fetch(`${fake.baseUrl}/other`)).status).toBe(404);
  });

  it('records each request with its step and the tools it offered', () => {
    expect(
      fake.requests.some(
        (r) => r.model === 'two-steps' && r.step === 1 && r.toolNames.includes('read_files'),
      ),
    ).toBe(true);
  });
});
