/**
 * npm run setup: registers Swage's editor-tools MCP server and upserts the agents from
 * trueforge/agents for every model profile (blueprint section 9, step 5). Idempotent.
 *
 *   TRUEFORGE_BASE_URL   default http://localhost:8790
 *   SWAGE_MCP_URL        the extension's MCP endpoint, for example http://127.0.0.1:53210/mcp
 *   SWAGE_MCP_TOKEN      its bearer token (read from the environment only; never printed)
 *   --profiles <file>    default config/models.yaml, else .yml, .json, else config/models.example.yaml
 */
import { readFileSync } from 'node:fs';
import { SwageClient } from '../src/client/client';
import { formatReport, loadManifests, parseProfiles, runSetup } from '../src/client/setup';
import { loadProfilesFile } from '../src/resilience/profiles';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = flag('--base-url') ?? process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const explicit = flag('--profiles');
const { file: profilesFile, profiles } = explicit
  ? { file: explicit, profiles: parseProfiles(readFileSync(explicit, 'utf8'), explicit) }
  : loadProfilesFile('.');
const mcpUrl = flag('--mcp-url') ?? process.env['SWAGE_MCP_URL'];
const mcpToken = process.env['SWAGE_MCP_TOKEN'];

const client = new SwageClient({ baseUrl });
const report = await runSetup({
  client,
  profiles,
  manifests: loadManifests('trueforge/agents'),
  ...(mcpUrl && mcpToken ? { mcp: { url: mcpUrl, bearerToken: mcpToken } } : {}),
});
console.log(`TrueForge: ${baseUrl}\nProfiles: ${profilesFile}`);
for (const line of formatReport(report)) console.log(line);
if (report.mcp.status === 'error' || report.agents.some((a) => a.result === 'error'))
  process.exitCode = 1;
