// npm run add-ollama-model -- <ollama tag> [<ollama tag> ...]
// Adds local Ollama models (for example qwen2.5-coder:3b) to TrueForge's "ollama" provider, so
// Swage can use them as ollama/<slug>. Models already listed are kept: TrueForge refuses to drop
// a model that agents still use. The provider holds no credentials (only Ollama's local URL);
// the script refuses to rewrite a provider that has any field besides name, type, baseUrl and
// models.
import { execFileSync } from 'node:child_process';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const PROVIDER = 'ollama';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';
const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const tags = process.argv.slice(2);
if (tags.length === 0) {
  console.log('Usage: npm run add-ollama-model -- qwen2.5-coder:3b');
  process.exit(1);
}

/** TrueForge model name for an Ollama tag: qwen2.5-coder:3b -> qwen-2-5-coder-3b. */
export function slug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1-$2')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const installed = execFileSync('ollama', ['list'], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .map((l) => l.split(/\s+/)[0])
  .filter((t): t is string => Boolean(t));
const missing = tags.filter((t) => !installed.includes(t));
if (missing.length > 0) {
  console.log(`Not in Ollama yet: ${missing.join(', ')}. Run: ollama pull ${missing[0]}`);
  process.exit(1);
}

const sdk = new TrueForge({ baseUrl, timeoutInSeconds: 15 });
const listed = (await sdk.settings.modelProviders.list()) as unknown as
  { data?: Record<string, unknown>[] } | Record<string, unknown>[];
const providers = Array.isArray(listed) ? listed : (listed.data ?? []);
const current = providers
  .map((p) => (p['manifest'] ?? p) as Record<string, unknown>)
  .find((m) => m['name'] === PROVIDER);
const extra = Object.keys(current ?? {}).filter(
  (k) => !['name', 'type', 'baseUrl', 'models'].includes(k),
);
if (extra.length > 0) {
  console.log(
    `TrueForge's ${PROVIDER} provider has other settings (${extra.join(', ')}); add the model in TrueForge Settings, Models instead.`,
  );
  process.exit(1);
}

await sdk.settings.modelProviders.createOrUpdate({
  manifest: {
    type: 'custom',
    name: PROVIDER,
    baseUrl: (current?.['baseUrl'] as string | undefined) ?? OLLAMA_URL,
    models: [
      ...((current?.['models'] as { name: string; modelId: string }[] | undefined) ?? []).filter(
        (m) => !tags.some((t) => slug(t) === m.name),
      ),
      ...tags.map((t) => ({
        name: slug(t),
        modelId: t,
        properties: { contextLength: 16384, maxOutputTokens: 4096 },
      })),
    ] as never,
  },
});
console.log(`Added to TrueForge's ${PROVIDER} provider:`);
for (const t of tags) console.log(`  ${PROVIDER}/${slug(t)}  (Ollama ${t})`);
