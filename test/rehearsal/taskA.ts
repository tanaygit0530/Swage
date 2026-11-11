/**
 * Task A rehearsal (blueprint section 10) on a fresh clone of Flask 3.1.3, with no TrueForge and
 * no model: the scripted TrueForge stand-in plays test/rehearsal/task-a-flask.json against the
 * real MCP server, InlineEdit and the review and apply machinery, then runs the statement's
 * verification command and the Flask tests in the clone. The original checkout is never touched.
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
      onStart?: (edit: InlineEdit) => Promise<void>,
    ): Promise<{
      edit: InlineEdit;
      outcome: InlineOutcome;
      fake: FakeTrueForge;
      ms: number;
      statuses: string[];
    }> {
      const fake = new FakeTrueForge({
        scenario: scenario(name),
        mcp: { url: server.url, token: server.token },
      });
      const statuses: string[] = [];
      const edit = new InlineEdit({
        client: new SwageClient({ baseUrl: 'http://fake', sdk: fake.sdk }),
        ctx,
        relay: new EventRelay(),
        approvals: new ApprovalList(),
        agentName: 'swage-inline-rehearsal',
        request,
        onStatus: (s) => statuses.push(s),
        logger,
      });
      const started = performance.now();
      const running = edit.start();
      if (onStart) await onStart(edit);
      const outcome = await running;
      const ms = Math.round(performance.now() - started);
      await fake.close();
      return { edit, outcome, fake, ms, statuses };
    }

    // A0: the cancel demo.
    say('\n== A0: cancel mid-stream ==');
    const a0 = await inline('task-a-flask-cancel', async (edit) => {
      while (!edit.text.includes('token5')) await new Promise((r) => setTimeout(r, 20));
      const c0 = performance.now();
      const cancelling = edit.cancel();
      say(
        `Stop pressed after "${edit.text.trim().split(' ').slice(-1)[0] ?? ''}"; UI state "${edit.run.state}" after ${(performance.now() - c0).toFixed(1)} ms`,
      );
      await cancelling;
    });
    say(`Outcome: ${a0.outcome.kind}: ${a0.outcome.message}`);
    say(
      `Tools executed: ${a0.fake.log.filter((l) => l.startsWith('tool ')).length}; TrueForge cancel sent: ${a0.fake.log.includes('session.cancel sess-1')}`,
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
    for (const l of a.fake.log.filter((x) => x.startsWith('tool '))) say(`  ${l.slice(0, 220)}`);
    if (a.outcome.kind !== 'review')
      throw new Error(`expected a review, got ${a.outcome.kind}: ${a.outcome.message}`);
    say(
      `Instruction to diff: ${a.ms} ms (scripted model, 30 ms between chunks). ${a.outcome.message}`,
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
    const [doc, logic] = blocks;
    session.reject(HELPERS, doc?.id ?? '');
    say(
      `Reject block 1: preview has the docstring line: ${session.preview(HELPERS).content.includes('``off`` and ``n``')}`,
    );
    session.accept(HELPERS, doc?.id ?? '');
    say(
      `Revert (accept block 1): preview has the docstring line: ${session.preview(HELPERS).content.includes('``off`` and ``n``')}`,
    );
    session.accept(HELPERS, logic?.id ?? '');
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
        tools: a0.fake.log.filter((l) => l.startsWith('tool ')).length,
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
