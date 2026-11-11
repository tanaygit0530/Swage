/**
 * Task A rehearsal (blueprint section 10) on a fresh clone of Flask 3.1.3. Scripted mode needs no
 * TrueForge and no model: the stand-in plays test/rehearsal/task-a-flask.json. Live mode registers
 * the editor tools and the inline agent with a running TrueForge and lets the real model edit.
 * Both go through the real MCP server, InlineEdit and the review and apply machinery, then run the
 * statement's verification command and the Flask tests in the clone. The original is never touched.
 *
 * Run: npm run rehearse:task-a (SWAGE_FLASK_DIR defaults to ../flask).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fsp, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventRelay } from '../../src/agent/relay';
import { Applier, type WorkspaceFs } from '../../src/changeset/apply';
import { SwageClient } from '../../src/client/client';
import { agentNameFor, type ModelProfile } from '../../src/client/manifest';
import { formatReport, loadManifests, runSetup } from '../../src/client/setup';
import type { HostToWebview } from '../../src/ui/protocol';
import { Bm25Searcher } from '../../src/context/bm25';
import { WorkspaceIndex } from '../../src/context/indexer';
import { createParser } from '../../src/context/symbols';
import { buildInlineMessage, editRange } from '../../src/inline/context';
import { InlineEdit, type InlineOutcome } from '../../src/inline/run';
import { ApprovalList, createToolContext } from '../../src/mcp/context';
import { startEditorToolsServer } from '../../src/mcp/server';
import { EDITOR_TOOLS } from '../../src/mcp/tools/index';
import { ReviewSession } from '../../src/review/session';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { parseScenario } from '../fake-model/scenario';

const TASK_A =
  "In get_debug_flag, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const HELPERS = 'src/flask/helpers.py';

export interface LiveOptions {
  readonly baseUrl: string;
  readonly profile: ModelProfile;
}

export interface TaskAReport {
  readonly a0: { outcome: string; tools: number; status: string };
  readonly blocks: number;
  readonly diffMs: number;
  readonly verification: string;
  readonly values: Record<string, string>;
  readonly pytest: string;
  readonly pytestBaseline: string;
  readonly debugFlagTests: string;
  readonly statusAfterUndo: string;
  readonly undoAgain: string;
}

let python = 'python3';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function py(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = spawnSync(python, args, {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', PYTHONPATH: path.join(cwd, 'src'), ...env },
    encoding: 'utf8',
  });
  return `${r.stdout}${r.stderr}`.trim();
}

class NodeFs implements WorkspaceFs {
  constructor(private readonly root: string) {}
  read(p: string): Promise<string | undefined> {
    return fsp.readFile(path.join(this.root, p), 'utf8').catch(() => undefined);
  }
  async write(p: string, content: string): Promise<void> {
    await fsp.mkdir(path.dirname(path.join(this.root, p)), { recursive: true });
    await fsp.writeFile(path.join(this.root, p), content);
  }
  remove(p: string): Promise<void> {
    return fsp.rm(path.join(this.root, p), { force: true });
  }
}

/** pytest summary line plus the ids of failing tests, sorted. */
function pytest(root: string, ...args: string[]): string {
  const out = py(root, {}, '-m', 'pytest', ...args, '-q', '-rf', '-p', 'no:cacheprovider');
  const failed = out
    .split('\n')
    .filter((l) => l.startsWith('FAILED '))
    .map((l) => l.split(' ')[1] ?? '')
    .sort();
  return [out.split('\n').at(-1) ?? '', ...failed].join('\n');
}

function scenario(name: string): ReturnType<typeof parseScenario> {
  const file = path.join(__dirname, `${name}.json`);
  return parseScenario(readFileSync(file, 'utf8'), file);
}

/** Runs the rehearsal on a clone of `flaskDir`; `say` receives the transcript line by line. */
export async function rehearseTaskA(
  flaskDir: string,
  say: (line?: string) => void,
  live?: LiveOptions,
): Promise<TaskAReport> {
  python = path.join(flaskDir, '.venv', 'bin', 'python');
  const values: Record<string, string> = {};
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-task-a-')));
  try {
    git(flaskDir, 'rev-parse', 'HEAD');
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', flaskDir, root]);
    say(
      `Flask clone: ${git(root, 'describe', '--tags')} (${git(root, 'rev-parse', '--short', 'HEAD')}), status clean: ${git(root, 'status', '--porcelain') === ''}`,
    );
    say(
      `Python: ${py(root, {}, '-c', 'import flask.helpers as h, sys; print(sys.version.split()[0], h.__file__)').replace(root, '<clone>')}`,
    );

    const t0 = performance.now();
    const index = new WorkspaceIndex({ root, parser: await createParser(), cache: null });
    const stats = await index.build();
    say(
      `Index: ${stats.files} files (${stats.parsed} parsed) in ${Math.round(performance.now() - t0)} ms`,
    );
    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const ctx = createToolContext({
      root,
      index,
      searcher: new Bm25Searcher(index),
      events: new EventRelay(),
      approvals: new ApprovalList(),
      logger,
    });
    const server = await startEditorToolsServer({ context: ctx, tools: EDITOR_TOOLS });
    let liveClient: SwageClient | undefined;
    let liveAgent = '';
    if (live) {
      liveClient = new SwageClient({ baseUrl: live.baseUrl });
      const setup = await runSetup({
        client: liveClient,
        profiles: [live.profile],
        manifests: loadManifests(path.join(__dirname, '..', '..', 'trueforge', 'agents')),
        mcp: { url: server.url, bearerToken: server.token },
      });
      for (const line of formatReport(setup)) say(`setup: ${line}`);
      liveAgent = agentNameFor('swage-inline', live.profile);
      say(
        `Live: TrueForge ${live.baseUrl}, agent ${liveAgent}, model ${live.profile.trueforgeModel}`,
      );
    }

    const text = readFileSync(path.join(root, HELPERS), 'utf8');
    const symbols = index.get(HELPERS)?.symbols ?? [];
    const cursor =
      text.split('\n').findIndex((l) => l.includes('val = os.environ.get("FLASK_DEBUG")')) + 1;
    const range = editRange(symbols, {
      startLine: cursor,
      endLine: cursor,
      endCharacter: 4,
      empty: true,
    });
    const request = {
      instruction: TASK_A,
      path: HELPERS,
      text,
      range,
      symbols,
      language: 'python',
    };
    const first = buildInlineMessage(request);
    say(
      `Cursor on line ${cursor}, no selection: target ${HELPERS} lines ${range.startLine}-${range.endLine} (${symbols.find((s) => s.line === range.startLine)?.name ?? '?'})`,
    );
    say(
      `First message: ${first.used} tokens; ${first.parts.map((p) => `${p.label} ${p.tokens}`).join(', ')}`,
    );

    async function inline(
      name: string,
      onStart?: (edit: InlineEdit, statuses: string[]) => Promise<void>,
    ): Promise<{
      edit: InlineEdit;
      outcome: InlineOutcome;
      fake: FakeTrueForge | undefined;
      ms: number;
      statuses: string[];
      tools: string[];
    }> {
      const fake = live
        ? undefined
        : new FakeTrueForge({
            scenario: scenario(name),
            mcp: { url: server.url, token: server.token },
          });
      const statuses: string[] = [];
      const tools: string[] = [];
      const names = new Map<string, string>();
      const onEvent = (m: HostToWebview): void => {
        if (m.type === 'tool_start') names.set(m.toolCallId, m.name);
        if (m.type === 'tool_end')
          tools.push(`${names.get(m.toolCallId) ?? '?'}${m.error ? ' (error)' : ''}`);
      };
      const edit = new InlineEdit({
        client: liveClient ?? new SwageClient({ baseUrl: 'http://fake', sdk: fake?.sdk }),
        ctx,
        relay: new EventRelay(),
        approvals: new ApprovalList(),
        agentName: live ? liveAgent : 'swage-inline-rehearsal',
        request,
        onStatus: (s) => statuses.push(s),
        onEvent,
        logger,
      });
      const started = performance.now();
      const running = edit.start();
      if (onStart) await onStart(edit, statuses);
      const outcome = await running;
      const ms = Math.round(performance.now() - started);
      // Let a cancelled stream drain before the next run.
      for (let i = 0; i < 300 && edit.run.draining; i++)
        await new Promise((r) => setTimeout(r, 50));
      await fake?.close();
      return { edit, outcome, fake, ms, statuses, tools };
    }

    // A0: the cancel demo.
    say('\n== A0: cancel mid-stream ==');
    const a0 = await inline('task-a-flask-cancel', async (edit, statuses) => {
      // Scripted: after the sixth token. Live: as soon as the model streams or calls a tool.
      const streaming = (): boolean =>
        live
          ? statuses.length > 2 || (edit.run.state !== 'running' && edit.run.state !== 'starting')
          : edit.text.includes('token5');
      while (!streaming()) await new Promise((r) => setTimeout(r, 10));
      const c0 = performance.now();
      const cancelling = edit.cancel();
      say(
        `Stop pressed after "${edit.text.trim().split(' ').slice(-1)[0] ?? ''}"; UI state "${edit.run.state}" after ${(performance.now() - c0).toFixed(1)} ms`,
      );
      await cancelling;
    });
    say(`Outcome: ${a0.outcome.kind}: ${a0.outcome.message}`);
    say(
      `Tools finished: ${a0.tools.length}${a0.fake ? `; TrueForge cancel sent: ${a0.fake.log.includes('session.cancel sess-1')}` : ''}`,
    );
    const a0Status = git(root, 'status', '--porcelain');
    say(`git status --porcelain: "${a0Status}"`);

    const pytestBaseline = pytest(root, 'tests/test_helpers.py');
    say(
      `Baseline pytest tests/test_helpers.py (before any edit): ${pytestBaseline.replace(/\n/g, '; ')}`,
    );

    // A: the real run.
    say('\n== A: inline edit ==');
    const a = await inline('task-a-flask');
    say(
      `Status bar: ${[...new Set(a.statuses)].slice(0, 4).join(' -> ')} … ${a.statuses.at(-1) ?? ''}`,
    );
    say(`Tools: ${a.tools.join(', ')}`);
    say(`Model reply: ${a.edit.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    for (const l of a.fake?.log.filter((x) => x.startsWith('tool ')) ?? [])
      say(`  ${l.slice(0, 220)}`);
    if (a.outcome.kind !== 'review')
      throw new Error(`expected a review, got ${a.outcome.kind}: ${a.outcome.message}`);
    say(
      `Instruction to diff: ${a.ms} ms (${live ? `live model ${live.profile.trueforgeModel}` : 'scripted model, 30 ms between chunks'}). ${a.outcome.message}`,
    );
    const session = new ReviewSession(a.outcome.taskId, a.outcome.changeSet);
    const blocks = session.preview(HELPERS).blocks;
    for (const [i, b] of blocks.entries()) {
      const raw = a.outcome.changeSet.review()[0]?.blocks.find((x) => x.id === b.id);
      say(
        `  Block ${i + 1}/${blocks.length} (${b.id}) +${b.added} -${b.removed}, old line ${(raw?.oldStart ?? 0) + 1}:`,
      );
      for (const l of raw?.oldLines ?? []) say(`    - ${l.replace(/\n$/, '')}`);
      for (const l of raw?.newLines ?? []) say(`    + ${l.replace(/\n$/, '')}`);
    }
    // The video's sequence: reject block 1, revert it, then accept each block separately.
    const block1 = blocks[0];
    const withFirst = session.preview(HELPERS).content;
    session.reject(HELPERS, block1?.id ?? '');
    const withoutFirst = session.preview(HELPERS).content;
    say(`Reject block 1: preview changed: ${withoutFirst !== withFirst}`);
    session.accept(HELPERS, block1?.id ?? '');
    say(
      `Revert (accept block 1): preview back to the proposal: ${session.preview(HELPERS).content === withFirst}`,
    );
    for (const b of blocks.slice(1)) session.accept(HELPERS, b.id);
    say(`Outside the selection: ${JSON.stringify([...a.outcome.outside])}`);
    say(`Totals: ${JSON.stringify(session.totals())}`);

    const applier = new Applier(new NodeFs(root), { maxUndo: 2 });
    const applied = await applier.apply(session.taskId, session.result().changes);
    say(
      `Apply: ${applied.ok ? `ok, ${applied.checkpoint.entries.length} file(s)` : applied.error.message}`,
    );
    say(`git diff --stat: ${git(root, 'diff', '--stat').split('\n').join(' | ')}`);

    say('\n== Verification ==');
    const cmd = 'from flask.helpers import get_debug_flag; print(get_debug_flag())';
    say(`FLASK_DEBUG=off python -c "${cmd}" -> ${py(root, { FLASK_DEBUG: 'off' }, '-c', cmd)}`);
    const verification = py(root, { FLASK_DEBUG: 'off' }, '-c', cmd);
    for (const v of ['OFF', 'n', 'N', 'no', 'False', '0', '1', 'on', 'yes']) {
      values[v] = py(root, { FLASK_DEBUG: v }, '-c', cmd);
      say(`  FLASK_DEBUG=${v} -> ${values[v]}`);
    }
    say(`  FLASK_DEBUG unset -> ${py(root, {}, '-c', cmd)}`);
    say(
      `Docstring:\n${py(root, {}, '-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)')}`,
    );
    const after = pytest(root, 'tests/test_helpers.py');
    say(`pytest tests/test_helpers.py after the edit: ${after.replace(/\n/g, '; ')}`);
    const debugFlagTests = pytest(root, 'tests/test_helpers.py', '-k', 'debug_flag');
    say(`pytest -k debug_flag: ${debugFlagTests}`);
    say(`py_compile: ${py(root, {}, '-m', 'py_compile', HELPERS) || 'ok'}`);

    say('\n== Undo ==');
    const undo = await applier.undo();
    say(
      `Undo: ${undo.ok ? 'ok' : undo.error.message}; git status --porcelain: "${git(root, 'status', '--porcelain')}"`,
    );
    const statusAfterUndo = git(root, 'status', '--porcelain');
    const again = await applier.undo();
    say(`Undo again: ${again.ok ? 'ok' : again.error.code}`);

    await server.stop();
    return {
      a0: {
        outcome: `${a0.outcome.kind}: ${a0.outcome.message}`,
        tools: a0.tools.length,
        status: a0Status,
      },
      blocks: blocks.length,
      diffMs: a.ms,
      verification,
      values,
      pytest: after,
      pytestBaseline,
      debugFlagTests,
      statusAfterUndo,
      undoAgain: again.ok ? 'ok' : again.error.code,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
