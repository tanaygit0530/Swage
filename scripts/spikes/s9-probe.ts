/**
 * Spike S9 (blueprint section 14): which configured models call tools reliably?
 * Each trial opens a fresh session with a stub MCP tool and asks for one read_files call.
 * Pass: the tool was called with README.md and the turn ended done. Goal: 8 of 10.
 * Usage: npm run spike -- scripts/spikes/s9-probe.ts [--trials 10] [--only primary]
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describeError } from '../../src/client/client';
import { parseProfiles } from '../../src/client/setup';
import { QUIET_CONFIG, recordTurn, sdkFor, sleep, summarize, userMessage } from './common';
import { startStubMcp } from './stubMcp';

const args = process.argv.slice(2);
const trials = Number(args[args.indexOf('--trials') + 1] ?? 10) || 10;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const sdk = sdkFor(baseUrl);
const file = existsSync('config/models.json') ? 'config/models.json' : 'config/models.example.json';
const profiles = parseProfiles(readFileSync(file, 'utf8')).filter((p) => !only || p.name === only);

const token = randomBytes(24).toString('hex');
const stub = await startStubMcp({ token });
const MCP = 'swage-spike-tools';
await sdk.settings.mcpServers.createOrUpdate({
  manifest: {
    type: 'remote',
    name: MCP,
    url: stub.url,
    description: 'Swage spike tools (temporary)',
    auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
  },
});
const tools = await sdk.mcpServers.listTools(MCP);
console.log(
  `stub MCP registered; TrueForge sees tools: ${tools.data.map((t) => String(t['name'])).join(', ')}`,
);

const summary: string[] = [];
for (const profile of profiles) {
  console.log(`\n=== ${profile.name}: ${profile.trueforgeModel}`);
  let pass = 0;
  const times: number[] = [];
  for (let i = 1; i <= trials; i++) {
    const before = stub.calls.length;
    try {
      const { data: session } = await sdk.sessions.create({
        agent: {
          spec: {
            model: { name: profile.trueforgeModel, params: { temperature: 0, maxTokens: 512 } },
            instructions:
              'You work in a code repository. Use the read_files tool whenever you need file contents.',
            mcpServers: [
              {
                name: MCP,
                enableTools: ['@all'],
                preloadTools: ['read_files'],
                requireApprovalForTools: [],
              },
            ],
            config: QUIET_CONFIG,
          },
        },
      });
      const r = await recordTurn(
        sdk,
        session.id,
        userMessage(
          'Use the read_files tool to read README.md, then tell me the first line of the file.',
        ),
        180_000,
      );
      const called = stub.calls
        .slice(before)
        .some((c) => c.tool === 'read_files' && JSON.stringify(c.args).includes('README.md'));
      const ok = called && r.terminal?.status === 'done';
      if (ok) pass++;
      times.push(r.ms);
      console.log(
        `trial ${i}: ${ok ? 'PASS' : 'FAIL'} in ${r.ms} ms (first text ${r.firstTextMs ?? '-'} ms) | tool called: ${called} | ${summarize(r.terminal)}${r.transportError ? ` | ${r.transportError}` : ''}`,
      );
    } catch (err) {
      console.log(`trial ${i}: FAIL (${describeError(err)})`);
    }
    await sleep(profile.kind === 'local' ? 0 : 4000);
  }
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
  summary.push(
    `${profile.name.padEnd(11)} ${profile.trueforgeModel.padEnd(36)} ${pass}/${trials} valid tool calls, median ${median} ms`,
  );
}

await sdk.settings.mcpServers
  .delete(MCP)
  .catch((err: unknown) => console.log(`cleanup failed: ${describeError(err)}`));
await stub.stop();
console.log(`\n=== S9 summary\n${summary.join('\n')}`);
