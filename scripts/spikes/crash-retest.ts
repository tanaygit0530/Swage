/**
 * Retest of upstream issue 878 on the pinned TrueForge: does TrueForge crash when a
 * registered MCP server goes away mid-session? Runs a separate, throwaway TrueForge through
 * Swage's supervisor (free port, temporary SQLite), a local fake model and a stub MCP server,
 * so the main TrueForge and its settings are never touched. Fully offline.
 * Usage: npm run spike -- scripts/spikes/crash-retest.ts
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describeError } from '../../src/client/client';
import { TrueForgeSupervisor, type SupervisorState } from '../../src/supervisor/supervisor';
import { healthz, QUIET_CONFIG, recordTurn, sdkFor, sleep, summarize, userMessage } from './common';
import { startFakeOpenAi } from './fakeOpenAi';
import { startStubMcp } from './stubMcp';

const dataDir = mkdtempSync(path.join(tmpdir(), 'swage-crash-'));
const token = randomBytes(24).toString('hex');
const stub = await startStubMcp({ token });
const model = await startFakeOpenAi('tool-then-text');
const states: string[] = [];
const sup = new TrueForgeSupervisor({
  sqlitePath: path.join(dataDir, 'trueforge.sqlite'),
  healthTimeoutMs: 300_000,
  logger: {
    info: () => undefined,
    warn: (m) => console.log(`  [tf] ${m}`),
    error: (m) => console.log(`  [tf] ${m}`),
  },
});
sup.onStateChange((s: SupervisorState, d?: string) => {
  states.push(`${s}${d ? `(${d})` : ''}`);
  console.log(`  supervisor: ${s}${d ? ` (${d})` : ''}`);
});

const watch = async (label: string, seconds: number): Promise<void> => {
  const seen = new Set<string>();
  for (let i = 0; i < seconds; i++) {
    seen.add(await healthz(sup.baseUrl ?? ''));
    await sleep(1000);
  }
  console.log(
    `${label}: /healthz over ${seconds} s -> ${[...seen].join(', ')} | supervisor ${sup.state}`,
  );
};

try {
  const t0 = Date.now();
  const baseUrl = await sup.start();
  console.log(`throwaway TrueForge ready at ${baseUrl} in ${Date.now() - t0} ms`);
  const sdk = sdkFor(baseUrl);
  await sdk.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'custom',
      name: 'spike-fake',
      baseUrl: model.baseUrl,
      models: [
        {
          name: 'fake',
          modelId: 'fake',
          properties: { contextLength: 8192, maxOutputTokens: 256 },
        },
      ],
    },
  });
  await sdk.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name: 'swage-spike-tools',
      url: stub.url,
      description: 'Swage spike tools',
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    },
  });
  const spec = {
    model: { name: 'spike-fake/fake' },
    instructions: 'Use tools.',
    mcpServers: [
      {
        name: 'swage-spike-tools',
        enableTools: ['@all' as const],
        preload: true,
        requireApprovalForTools: [],
      },
    ],
    config: QUIET_CONFIG,
  };
  const { data: session } = await sdk.sessions.create({ agent: { spec } });

  const first = await recordTurn(sdk, session.id, userMessage('read README.md'), 60_000);
  console.log(`\nturn 1 (MCP up): ${first.types.join(' > ')}`);
  console.log(
    `  tool calls: ${first.toolCalls.join(', ') || 'none'} | stub received ${stub.calls.length} call(s) | ${summarize(first.terminal)}`,
  );
  console.log(
    `  tool name as the model saw it: ${model.requests[0]?.tools?.map((t) => t.function?.name).join(', ') ?? '-'}`,
  );

  await stub.stop();
  console.log('\nstub MCP server stopped');
  await watch('after MCP stop', 20);

  const second = await recordTurn(sdk, session.id, userMessage('read README.md again'), 60_000);
  console.log(
    `turn 2 (MCP down, same session): ${second.types.join(' > ')} | ${summarize(second.terminal)}${second.transportError ? ` | ${second.transportError}` : ''}`,
  );
  await watch('after turn 2', 15);

  const { data: fresh } = await sdk.sessions.create({ agent: { spec } });
  const third = await recordTurn(sdk, fresh.id, userMessage('read README.md'), 60_000);
  console.log(
    `turn 3 (MCP down, new session): ${third.types.join(' > ')} | ${summarize(third.terminal)}${third.transportError ? ` | ${third.transportError}` : ''}`,
  );
  await watch('after turn 3', 10);

  const crashed = states.some((s) => s.startsWith('restarting') || s.startsWith('failed'));
  console.log(
    `\nRESULT: TrueForge ${crashed ? 'CRASHED (supervisor had to restart it)' : 'stayed up'} after the MCP server went away.`,
  );
} catch (err) {
  console.log(`spike failed: ${describeError(err)}`);
} finally {
  await sup.stop();
  await model.stop();
  await stub.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
