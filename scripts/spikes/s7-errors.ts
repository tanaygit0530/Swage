/**
 * Spike S7 (blueprint section 14): what do an unreachable endpoint, a 401 and a hang look
 * like on the wire, and how long until the error? Uses temporary custom providers that point
 * at 127.0.0.1 or at addresses that cannot answer; nothing is sent to a real provider.
 * Usage: npm run spike -- scripts/spikes/s7-errors.ts   (TRUEFORGE_BASE_URL, default :8790)
 */
import { describeError } from '../../src/client/client';
import { QUIET_CONFIG, recordTurn, sdkFor, summarize, userMessage } from './common';
import { startFakeOpenAi } from './fakeOpenAi';

const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const sdk = sdkFor(baseUrl);
const unauthorized = await startFakeOpenAi('unauthorized');
const hang = await startFakeOpenAi('hang');

const cases = [
  {
    name: 'swage-spike-refused',
    why: 'connection refused (127.0.0.1:9)',
    baseUrl: 'http://127.0.0.1:9/v1',
  },
  {
    name: 'swage-spike-badkey',
    why: 'HTTP 401 invalid API key (local fake)',
    baseUrl: unauthorized.baseUrl,
    apiKey: 'not-a-real-key',
  },
  {
    name: 'swage-spike-dns',
    why: 'unknown host (.invalid never resolves)',
    baseUrl: 'https://swage-spike.invalid/v1',
  },
  {
    name: 'swage-spike-private',
    why: 'non-allowlisted private address 10.255.255.1',
    baseUrl: 'http://10.255.255.1/v1',
  },
  {
    name: 'swage-spike-hang',
    why: 'accepts the request, never answers (local fake)',
    baseUrl: hang.baseUrl,
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.name}: ${c.why}`);
  try {
    await sdk.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom',
        name: c.name,
        baseUrl: c.baseUrl,
        models: [
          {
            name: 'probe',
            modelId: 'probe',
            properties: { contextLength: 8192, maxOutputTokens: 256 },
          },
        ],
        ...(c.apiKey ? { auth: { apiKey: c.apiKey } } : {}),
      },
    });
  } catch (err) {
    console.log(`provider PUT failed: ${describeError(err)}`);
    continue;
  }
  try {
    const { data: session } = await sdk.sessions.create({
      agent: {
        spec: {
          model: { name: `${c.name}/probe` },
          instructions: 'Say hello.',
          config: QUIET_CONFIG,
        },
      },
    });
    const r = await recordTurn(sdk, session.id, userMessage('say hello'), 150_000);
    console.log(`events: ${r.types.join(' > ')}`);
    console.log(
      `terminal after ${r.ms} ms: ${summarize(r.terminal)}${r.cappedAt ? ` (we cancelled at ${r.cappedAt} ms)` : ''}`,
    );
    if (r.transportError) console.log(`transport error: ${r.transportError}`);
    console.log(`raw terminal state: ${JSON.stringify(r.terminal)}`);
  } catch (err) {
    console.log(`session failed: ${describeError(err)}`);
  } finally {
    await sdk.settings.modelProviders
      .delete(c.name)
      .catch((err: unknown) => console.log(`cleanup failed: ${describeError(err)}`));
  }
}
console.log(
  `\nfake 401 endpoint received ${unauthorized.requests.length} request(s); hang endpoint ${hang.requests.length}`,
);
await unauthorized.stop();
await hang.stop();
