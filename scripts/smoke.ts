/**
 * npm run smoke: sends "say hello" through TrueForge to the primary model and prints the
 * streamed reply. Manual check that the whole path works: SDK, session, turn stream, model.
 *
 *   TRUEFORGE_BASE_URL   default http://localhost:8790
 *   --profile <name>     default: the first profile (primary)
 *   --message <text>     default: "say hello"
 */
import { SwageClient } from '../src/client/client';
import { loadProfilesFile } from '../src/resilience/profiles';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const { file, profiles } = loadProfilesFile('.');
const wanted = flag('--profile');
const profile = wanted ? profiles.find((p) => p.name === wanted) : profiles[0];
if (!profile) throw new Error(`No profile named ${wanted ?? '(first)'} in ${file}`);
const message = flag('--message') ?? 'say hello';

const client = new SwageClient({ baseUrl });
console.log(`TrueForge ${baseUrl} | profile ${profile.name} | model ${profile.trueforgeModel}`);
const sessionId = await client.createInlineSession({
  model: { name: profile.trueforgeModel, params: { temperature: 0, maxTokens: 256 } },
  instructions: 'You are a friendly assistant. Answer in one short sentence.',
  config: {
    sandbox: { enabled: false },
    generativeUi: { enabled: false },
    askUserQuestions: { enabled: false },
    dynamicSubAgents: { enabled: false },
    iterationLimit: 2,
  },
});
console.log(`session ${sessionId}\n> ${message}`);

const started = Date.now();
let firstToken: number | undefined;
let exitCode = 0;
for await (const event of client.sendMessage(sessionId, message)) {
  if (event.type === 'text') {
    firstToken ??= Date.now() - started;
    process.stdout.write(event.delta);
  } else if (event.type === 'done') {
    console.log(
      `\n\ndone in ${Date.now() - started} ms (first token ${firstToken ?? '-'} ms${event.totalTokens ? `, ${event.totalTokens} tokens` : ''})`,
    );
  } else if (event.type === 'cancelled') {
    console.log(`\ncancelled: ${event.reason}`);
    exitCode = 1;
  } else if (event.type === 'error') {
    console.log(`\nerror: ${event.message}`);
    exitCode = 1;
  }
}
process.exitCode = exitCode;
