import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Scripted model scenarios (blueprint section 11: "a scripted fake model"). One scenario is one
 * conversation: step N is the model's reply to its N-th request in that conversation, counted by
 * the assistant messages already in the request, so TrueForge's retries replay the same step.
 */

export const ToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const StepSchema = z
  .object({
    /** Text streamed as separate deltas. */
    text: z.array(z.string()).optional(),
    /** Tool calls emitted after the text, all in the same reply. */
    toolCalls: z.array(ToolCallSchema).optional(),
    /** Delay before the first chunk. */
    firstTokenDelayMs: z.number().int().min(0).optional(),
    /** Delay between chunks. */
    chunkDelayMs: z.number().int().min(0).optional(),
    /** After this many chunks, pause for stallMs (a stalled stream). */
    stallAfterChunks: z.number().int().min(0).optional(),
    stallMs: z.number().int().min(0).optional(),
    /** Fail instead of answering: HTTP 429 or 500, drop the connection, or never answer. */
    error: z
      .union([z.literal(429), z.literal(500), z.literal('refused'), z.literal('hang')])
      .optional(),
    /** Fail only for the first N attempts at this step, then answer normally. */
    errorTimes: z.number().int().min(1).optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/,
        'scenario names must be valid TrueForge model names',
      ),
    description: z.string().optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

export type ScenarioToolCall = z.infer<typeof ToolCallSchema>;
export type ScenarioStep = z.infer<typeof StepSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/** In bundled scripts (ESM) `__dirname` does not exist; they run from the repository root. */
export const SCENARIO_DIR =
  typeof __dirname === 'string'
    ? path.join(__dirname, 'scenarios')
    : path.join(process.cwd(), 'test', 'fake-model', 'scenarios');

export function parseScenario(json: string, source = 'scenario'): Scenario {
  const result = ScenarioSchema.safeParse(JSON.parse(json));
  if (!result.success)
    throw new Error(
      `${source}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return result.data;
}

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseScenario(readFileSync(path.join(dir, f), 'utf8'), f));
}

/** Text the model sends once the script has run out of steps. */
export const FINAL_TEXT = 'Done.';
