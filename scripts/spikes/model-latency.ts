/**
 * Latency of candidate models through TrueForge for an edit-sized answer (about 250 output
 * tokens), three times each. Usage: npm run spike -- scripts/spikes/model-latency.ts <model> [...]
 */
import { SwageClient } from '../../src/client/client';
const client = new SwageClient({
  baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
});
const prompt =
  'Rewrite this Python function so it also treats "off" and "n" as false, and list every false value in its docstring. Reply with the code only.\n\ndef get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n';
for (const model of process.argv.slice(2)) {
  const times: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    let first: number | undefined;
    let note = '';
    try {
      const id = await client.createInlineSession({
        model: { name: model, params: { temperature: 0, maxTokens: 1024 } },
        instructions: 'You are a concise coding assistant.',
        config: {
          sandbox: { enabled: false },
          generativeUi: { enabled: false },
          askUserQuestions: { enabled: false },
          dynamicSubAgents: { enabled: false },
          iterationLimit: 1,
        },
      });
      for await (const e of client.sendMessage(id, prompt)) {
        if (e.type === 'text') first ??= Date.now() - t0;
        if (e.type === 'error') note = ` ERROR ${e.message.slice(0, 90)}`;
        if (e.type === 'done') note = ` ${e.totalTokens ?? '?'} tok`;
      }
    } catch (err) {
      note = ` THROW ${(err as Error).message.slice(0, 80)}`;
    }
    times.push(
      `${((Date.now() - t0) / 1000).toFixed(1)} s (first ${first === undefined ? '-' : (first / 1000).toFixed(1)} s${note})`,
    );
  }
  console.log(`${model.padEnd(42)} ${times.join(' | ')}`);
}
