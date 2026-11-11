/**
 * Prints the event timeline of the latest session (or a given one): event types, timestamps and
 * model usage, to see where a turn's time went. Usage: npm run spike -- scripts/spikes/session-timeline.ts [session-id]
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
const sdk = new TrueForge({
  baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
});
let id = process.argv[2];
if (!id)
  for await (const s of await sdk.sessions.list()) {
    id = s.id;
    break;
  }
if (!id) throw new Error('no session');
const items: { event: Record<string, unknown> }[] = [];
for await (const e of await sdk.sessions.listEvents(id)) items.push(e as never);
items.reverse();
let t0: number | undefined;
for (const { event } of items) {
  const at = Date.parse(String(event['createdAt'] ?? event['created_at'] ?? ''));
  t0 ??= at;
  const extra = JSON.stringify(
    event['metrics'] ??
      event['usage'] ??
      (event['state'] as Record<string, unknown> | undefined)?.['metrics'] ??
      '',
  ).slice(0, 300);
  const calls = (event['toolCalls'] as { function?: { name?: string } }[] | undefined)
    ?.map((c) => c.function?.name)
    .join(',');
  console.log(
    `${String(at - (t0 ?? at)).padStart(7)} ms  ${String(event['type']).padEnd(24)} ${calls ?? ''} ${extra}`,
  );
}
