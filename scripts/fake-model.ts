/**
 * npm run fake-model: serves the scripted fake model on 127.0.0.1 (default port 8787) and, if
 * TrueForge is reachable, registers it as the custom provider `swage-fake` with one model per
 * scenario (`swage-fake/three-file-edit`, ...). No API key is involved. Stop with Ctrl+C.
 *
 *   SWAGE_FAKE_PORT      default 8787
 *   TRUEFORGE_BASE_URL   default http://localhost:8790
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { describeError } from '../src/client/client';
import { loadScenarios } from '../test/fake-model/scenario';
import { startFakeModel } from '../test/fake-model/server';

export const FAKE_PROVIDER = 'swage-fake';

const port = Number(process.env['SWAGE_FAKE_PORT'] ?? 8787);
const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const scenarios = loadScenarios();
const fake = await startFakeModel({ scenarios, port });
console.log(`Fake model serving ${scenarios.length} scenarios at ${fake.baseUrl}`);

try {
  const sdk = new TrueForge({ baseUrl, timeoutInSeconds: 30 });
  await sdk.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'custom',
      name: FAKE_PROVIDER,
      baseUrl: fake.baseUrl,
      models: scenarios.map((s) => ({
        name: s.name,
        modelId: s.name,
        properties: { contextLength: 32768, maxOutputTokens: 4096 },
      })),
    },
  });
  console.log(`Registered provider ${FAKE_PROVIDER} in TrueForge at ${baseUrl}. Models:`);
  for (const s of scenarios) console.log(`  ${FAKE_PROVIDER}/${s.name}  ${s.description ?? ''}`);
} catch (err) {
  console.log(
    `Could not register the provider in TrueForge (${describeError(err)}). Start TrueForge and run this again.`,
  );
}

let served = 0;
setInterval(() => {
  if (fake.requests.length !== served) {
    for (const r of fake.requests.slice(served))
      console.log(`request: ${r.model} step ${r.step}${r.stream ? ' (stream)' : ''}`);
    served = fake.requests.length;
  }
}, 500);
process.on('SIGINT', () => {
  void fake.stop().then(() => process.exit(0));
});
