import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/context/tokens';
import { EDITOR_TOOLS } from '../../src/mcp/tools/index';
import { startHarness, type Harness } from './harness';

/**
 * B4 evidence: what deferred tool loading saves. Each tool definition is sized the way it is sent
 * to the model (name, description, JSON schema). The main agent preloads five tools and defers
 * the rest (trueforge/agents/main.agent.json); run with SWAGE_PRINT_TOOL_TOKENS=1 for the table.
 */
let h: Harness;
beforeAll(async () => {
  h = await startHarness(EDITOR_TOOLS);
});
afterAll(() => h.close());

describe('tool-definition tokens with deferred loading', () => {
  it('the preloaded set is smaller than all nine tools', async () => {
    const { tools } = await h.client.listTools();
    const size = new Map(
      tools.map((t) => [
        t.name,
        estimateTokens(
          JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }),
        ),
      ]),
    );
    const manifest = JSON.parse(readFileSync('trueforge/agents/main.agent.json', 'utf8')) as {
      mcp_servers: { preload_tools: string[] }[];
    };
    const preloaded = manifest.mcp_servers[0]?.preload_tools ?? [];
    const all = [...size.values()].reduce((a, b) => a + b, 0);
    const hot = preloaded.reduce((a, n) => a + (size.get(n) ?? 0), 0);
    if (process.env.SWAGE_PRINT_TOOL_TOKENS === '1') {
      process.stdout.write('| Tool | Tokens | Loaded |\n| --- | --- | --- |\n');
      for (const [n, t] of [...size.entries()].sort((a, b) => b[1] - a[1]))
        process.stdout.write(
          `| \`${n}\` | ${t} | ${preloaded.includes(n) ? 'preloaded' : 'deferred'} |\n`,
        );
      process.stdout.write(
        `| all nine | ${all} | |\n| preloaded five | ${hot} | saved ${all - hot} (${Math.round((100 * (all - hot)) / all)}%) |\n`,
      );
    }
    expect(tools).toHaveLength(9);
    expect(preloaded).toHaveLength(5);
    expect(hot).toBeLessThan(all);
  });
});
