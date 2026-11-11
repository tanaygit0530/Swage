/** Prints an agent's stored manifest (model, MCP servers, preload settings). Usage: npm run spike -- scripts/spikes/show-agent.ts <name> */
import { TrueForge } from '@truefoundry/trueforge-sdk';
const name = process.argv[2] ?? 'swage-inline-primary';
const sdk = new TrueForge({
  baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
});
for await (const a of await sdk.agents.list({ agentName: name })) {
  if (a.name !== name) continue;
  const full = await sdk.agents.get(a.id).catch(() => undefined);
  console.log(JSON.stringify(full?.data ?? a, null, 1).slice(0, 3000));
}
