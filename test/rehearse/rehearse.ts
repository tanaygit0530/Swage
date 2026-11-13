import * as assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import type { RunEventRecord } from '../../src/agent/controller';
import type { UndoResult } from '../../src/changeset/apply';
import { lostTests } from '../../src/changeset/testGuard';
import type { SwageTestApi } from '../../src/extension';
import type { InlineCommandResult } from '../../src/inline/vscode/controller';
import type { ApplyCommandResult } from '../../src/review/vscode/controller';
import { redactText } from '../../src/safety/redact';

/**
 * The rehearsal (blueprint sections 10, 11 and 17), run by scripts/rehearse.mjs in a test VS Code
 * opened on a clean Flask 3.1.3 clone, against the running TrueForge and real models. It uses the
 * problem statement's exact instructions and records evidence for every run: timings, tool calls,
 * tokens, the diff, the verification and the tests. Every run starts from a clean clone and is
 * undone afterwards, except the double-undo sequence, which undoes two change sets in a row.
 */

const DIR = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
const OUT = process.env.REHEARSE_OUT ?? path.join(tmpdir(), 'swage-rehearse-out');
const TASKS = new Set((process.env.REHEARSE_TASKS ?? 'cancel,a,toggle,undo,b,c').split(','));
const RUNS_A = Number(process.env.REHEARSE_RUNS_A ?? 5);
const RUNS_B = Number(process.env.REHEARSE_RUNS_B ?? 3);
const RUNS_C = Number(process.env.REHEARSE_RUNS_C ?? 3);
const FALLBACK = process.env.REHEARSE_FALLBACK_MODEL ?? 'google-gemini/gemini-3-5-flash-lite';
const TRUEFORGE = process.env.REHEARSE_TRUEFORGE ?? 'http://localhost:8790';
const PYTHON = path.join(DIR, '.venv', 'bin', 'python');
const HELPERS = 'src/flask/helpers.py';

// The problem statement's exact instructions (docs/PROBLEM_STATEMENT.pdf, "Task" table).
const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

let api: SwageTestApi;

// ---------------------------------------------------------------------------------------------
// Helpers

const clean = (s: string): string =>
  redactText(s).replaceAll(DIR, '<flask>').replaceAll(tmpdir(), '<tmp>').replaceAll(homedir(), '~');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: DIR, encoding: 'utf8' }).trim();
}

function py(args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync(PYTHON, args, {
    cwd: DIR,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    timeout: 300_000,
  });
  return { ok: r.status === 0, out: clean(`${r.stdout}${r.stderr}`).trim() };
}

function pytest(...args: string[]): { ok: boolean; summary: string; failed: string[] } {
  const r = py(['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-rf', ...args]);
  const lines = r.out.split('\n');
  return {
    ok: r.ok,
    summary: lines.at(-1) ?? '',
    failed: lines.filter((l) => l.startsWith('FAILED ')).map((l) => l.slice(7).split(' ')[0] ?? l),
  };
}

const status = (): string => git('status', '--porcelain');

async function reset(): Promise<void> {
  // Nothing from an earlier run may still be going (an agent run left behind would refuse the next).
  if (['starting', 'running'].includes(api.runState() ?? '')) {
    await vscode.commands.executeCommand('swage.stop');
    await waitFor(() => !['starting', 'running'].includes(api.runState() ?? ''), 30_000);
  }
  if (api.review.current) await vscode.commands.executeCommand('swage.review.discard');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  git('reset', '--quiet', '--hard', 'HEAD');
  git('clean', '-fdq', '-e', '.venv', '-e', '.vscode');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(100);
  }
  return true;
}

/** Selects the whole get_debug_flag function, as the statement asks. */
async function selectGetDebugFlag(): Promise<{ start: number; end: number }> {
  const doc = await vscode.workspace.openTextDocument(path.join(DIR, HELPERS));
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const lines = doc.getText().split('\n');
  const start = lines.findIndex((l) => l.startsWith('def get_debug_flag'));
  let end = start + 1;
  while (end + 1 < lines.length && !(lines[end + 1] === '' && lines[end + 2] === '')) end++;
  editor.selection = new vscode.Selection(start, 0, end, lines[end]?.length ?? 0);
  return { start: start + 1, end: end + 1 };
}

/** Event-loop lag in the extension host while something runs ("the editor stays responsive"). */
function lagMonitor(): { stop(): number } {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 50);
    last = now;
  }, 50);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.round(max);
    },
  };
}

interface ToolCall {
  name: string;
  at: number;
  ms?: number;
  args: string;
  result?: string;
  error?: boolean;
}

/** Records one run's events: tool calls with arguments and results, tokens, switches, text. */
class Recorder {
  readonly t0 = performance.now();
  readonly tools: ToolCall[] = [];
  readonly switches: string[] = [];
  readonly errors: string[] = [];
  readonly log: string[] = [];
  text = '';
  tokens = 0;
  turns = 0;
  firstEventMs: number | undefined;
  private readonly open = new Map<string, ToolCall>();
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = api.onRunEvent((r) => this.on(r));
  }

  get ms(): number {
    return Math.round(performance.now() - this.t0);
  }

  private line(s: string): void {
    this.log.push(`${String(this.ms).padStart(7)} ms  ${clean(s)}`);
  }

  private on(r: RunEventRecord): void {
    if ('switched' in r) {
      this.switches.push(r.switched);
      this.line(`SWITCH ${r.switched}`);
      return;
    }
    const e = r.event;
    if ((e.type === 'text' || e.type === 'tool_start') && this.firstEventMs === undefined)
      this.firstEventMs = this.ms;
    switch (e.type) {
      case 'turn_started':
        this.turns++;
        this.line(`turn started (${r.kind})`);
        break;
      case 'text':
        this.text += e.delta;
        break;
      case 'tool_start': {
        const call: ToolCall = {
          name: e.name,
          at: this.ms,
          args: clean(e.arguments).slice(0, 2000),
        };
        this.tools.push(call);
        this.open.set(e.toolCallId, call);
        this.line(`tool ${e.name} ${clean(e.arguments).slice(0, 400)}`);
        break;
      }
      case 'tool_result': {
        const call = this.open.get(e.toolCallId);
        if (call) {
          call.ms = this.ms - call.at;
          call.result = clean(e.content).slice(0, 4000);
          call.error = /^\s*\{\s*"error"/.test(e.content);
        }
        this.line(
          `result ${call?.name ?? '?'} (${e.content.length} chars${call?.error ? ', error' : ''}) ${clean(e.content).replace(/\s+/g, ' ').slice(0, 300)}`,
        );
        break;
      }
      case 'done':
        this.tokens += e.totalTokens ?? 0;
        this.line(
          `turn done${e.paused ? ' (paused for approval)' : ''}, ${e.totalTokens ?? '?'} tokens`,
        );
        break;
      case 'error':
        this.errors.push(clean(e.message));
        this.line(`ERROR ${e.message}`);
        break;
      case 'cancelled':
        this.line(`cancelled (${e.reason})`);
        break;
      default:
        break;
    }
  }

  stop(): void {
    this.sub.dispose();
    if (this.text)
      this.log.push(`model text: ${clean(this.text).replace(/\s+/g, ' ').slice(0, 2000)}`);
  }
}

function save(id: string, record: Record<string, unknown>, rec?: Recorder): void {
  mkdirSync(path.join(OUT, 'runs'), { recursive: true });
  mkdirSync(path.join(OUT, 'logs'), { recursive: true });
  const full = {
    id,
    at: new Date().toISOString(),
    ...record,
    ...(rec
      ? {
          tools: rec.tools.map((t) => ({
            name: t.name,
            ms: t.ms,
            error: t.error ?? false,
            args: t.args,
          })),
          toolSequence: rec.tools.map((t) => t.name),
          tokens: rec.tokens,
          turns: rec.turns,
          switches: rec.switches,
          modelErrors: rec.errors,
          firstEventMs: rec.firstEventMs,
        }
      : {}),
  };
  writeFileSync(path.join(OUT, 'runs', `${id}.json`), `${JSON.stringify(full, null, 2)}\n`);
  if (rec) writeFileSync(path.join(OUT, 'logs', `${id}.log`), `${rec.log.join('\n')}\n`);
  process.stdout.write(
    `  [${id}] ${record['ok'] ? 'OK' : 'FAIL'} ${String(record['summary'] ?? '')}\n`,
  );
}

const debugFlag = (value: string): string =>
  py(['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], {
    FLASK_DEBUG: value,
  }).out;

async function lensTitles(file: string): Promise<string[]> {
  const s = api.review.current;
  if (!s) return [];
  const uri = vscode.Uri.from({ scheme: 'swage-staged', path: `/${file}`, query: s.taskId });
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses.map((l) => l.command?.title ?? '');
}

// ---------------------------------------------------------------------------------------------
// Task A

async function taskA(
  id: string,
  opts: { toggle?: boolean; keep?: boolean } = {},
): Promise<boolean> {
  if (!opts.keep) await reset();
  const range = await selectGetDebugFlag();
  const rec = new Recorder();
  const result = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
    instruction: TASK_A,
  });
  const wallToReview = rec.ms;
  const record: Record<string, unknown> = {
    task: 'A',
    instruction: TASK_A,
    selection: `${HELPERS} lines ${range.start}-${range.end}`,
    model: api.models.router?.active.trueforgeModel,
    outcome: result.kind,
    // Only a run that produced a diff has a diff time (lastDiffMs keeps the previous run's value).
    instructionToDiffMs: result.kind === 'review' ? api.inline.lastDiffMs : undefined,
    wallToReviewMs: wallToReview,
  };
  if (result.kind !== 'review') {
    rec.stop();
    save(
      id,
      {
        ...record,
        ok: false,
        summary: `${result.kind}: ${result.message}`,
        reason: result.message,
      },
      rec,
    );
    await reset();
    return false;
  }
  const session = api.review.current;
  assert.ok(session);
  const blocks = session.preview(HELPERS).blocks;
  const diffInEditor = vscode.window.activeTextEditor?.document.uri.scheme === 'swage-staged';
  const titles = await lensTitles(HELPERS);
  const toggle: Record<string, boolean> = {};
  if (opts.toggle && blocks[0]) {
    const proposal = session.preview(HELPERS).content;
    await vscode.commands.executeCommand('swage.review.rejectBlock', {
      path: HELPERS,
      blockId: blocks[0].id,
    });
    toggle['rejectBlock1ChangesPreview'] = session.preview(HELPERS).content !== proposal;
    await vscode.commands.executeCommand('swage.review.acceptBlock', {
      path: HELPERS,
      blockId: blocks[0].id,
    });
    toggle['revertRestoresProposal'] = session.preview(HELPERS).content === proposal;
  }
  // "Review and accept the diff": accept each block on its own.
  for (const b of session.preview(HELPERS).blocks)
    await vscode.commands.executeCommand('swage.review.acceptBlock', {
      path: HELPERS,
      blockId: b.id,
    });
  const applied = await vscode.commands.executeCommand<ApplyCommandResult>('swage.review.apply', {
    confirmPending: false,
  });
  const diff = git('diff');
  const values: Record<string, string> = {};
  for (const v of ['off', 'OFF', 'n', 'N', 'no', '0', 'false', '1', 'on', 'yes'])
    values[v] = debugFlag(v);
  const doc = py([
    '-c',
    'from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)',
  ]).out;
  const docListsAll = ['0', 'false', 'no', 'off', 'n'].every((v) =>
    new RegExp(`['"\`]{1,2}${v}['"\`]{1,2}|\\b${v}\\b`, 'i').test(doc),
  );
  const tests = pytest('tests/test_helpers.py');
  const suite = pytest();
  const falseOk = ['off', 'OFF', 'n', 'N', 'no', '0', 'false'].every((v) => values[v] === 'False');
  const trueOk = ['1', 'on', 'yes'].every((v) => values[v] === 'True');
  const ok =
    applied.ok && values['off'] === 'False' && falseOk && trueOk && docListsAll && suite.ok;
  let undo: string | undefined;
  if (!opts.keep) {
    const u = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    undo = u.ok ? 'restored' : u.error.code;
  }
  rec.stop();
  save(
    id,
    {
      ...record,
      ok,
      summary: `${blocks.length} block(s), diff in ${((api.inline.lastDiffMs ?? 0) / 1000).toFixed(1)} s, FLASK_DEBUG=off -> ${values['off']}, suite ${suite.summary}`,
      blocks: blocks.length,
      diffInEditor,
      lenses: titles,
      toggle,
      applied: applied.ok,
      verification: {
        command:
          'FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
        output: values['off'],
        values,
      },
      docstring: doc,
      docListsAll,
      testsHelpers: tests,
      testsSuite: suite,
      diff,
      undo,
      gitStatusAfter: opts.keep ? '(kept for the double undo)' : status(),
    },
    rec,
  );
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Cancel before Task A

async function cancelDemo(id: string): Promise<void> {
  await reset();
  await selectGetDebugFlag();
  const rec = new Recorder();
  const running = vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
    instruction: TASK_A,
  });
  await waitFor(() => api.inline.running, 30_000);
  // Stop once the model has started answering (text or a tool call), as in the demo.
  await waitFor(() => rec.firstEventMs !== undefined || !api.inline.running, 60_000);
  const before = { text: rec.text.length, tools: rec.tools.length };
  const t = performance.now();
  await vscode.commands.executeCommand('swage.stop');
  const uiMs = Math.round(performance.now() - t);
  const result = await running;
  await sleep(1500); // late events have time to arrive (they must be dropped)
  rec.stop();
  const st = status();
  save(
    id,
    {
      task: 'cancel',
      ok: result.kind === 'cancelled' && st === '' && !api.review.current,
      summary: `${result.kind}: ${result.message}; Stop to UI ${uiMs} ms; git status ${st === '' ? 'clean' : 'DIRTY'}`,
      outcome: result.kind,
      message: result.message,
      stopToUiMs: uiMs,
      stoppedAfter: before,
      gitStatusAfter: st,
    },
    rec,
  );
}

// ---------------------------------------------------------------------------------------------
// Task B

const SAMPLE_APP = `from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="dev-secret-value",
    DATABASE_PASSWORD="hunter2",
    API_TOKEN="tok-123",
    STRIPE_KEY="key-456",
    GREETING="hello",
)
`;

function retrievalHits(rec: Recorder): string[] {
  const hits = new Set<string>();
  for (const t of rec.tools.filter((x) => x.name === 'find_relevant_code'))
    for (const m of (t.result ?? '').matchAll(
      /(?:^|\s|\()((?:src|tests|docs|examples)\/[\w./-]+\.\w+)/g,
    ))
      if (m[1]) hits.add(m[1]);
  return [...hits];
}

async function taskB(id: string, opts: { keep?: boolean } = {}): Promise<boolean> {
  if (!opts.keep) await reset();
  else await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const rec = new Recorder();
  const lag = lagMonitor();
  const previous = api.runTaskId();
  void api.startRun(TASK_B);
  // Wait for this run to exist before reading its state (the last run's state is still "done").
  const started = await waitFor(() => api.runTaskId() !== previous, 120_000);
  // Wait for the change set; answer any other approval card (a run_command) with a denial, as a
  // cautious user would, so the agent goes on with run_tests instead of waiting forever.
  const denied: string[] = [];
  const deadline = Date.now() + 15 * 60_000;
  let reviewed = false;
  while (started && Date.now() < deadline) {
    if (api.review.current !== undefined) {
      reviewed = true;
      break;
    }
    const state = api.runState() ?? '';
    if (['done', 'error', 'cancelled'].includes(state)) {
      reviewed = true;
      break;
    }
    if (state === 'paused')
      denied.push(
        ...(await api.decidePending(
          false,
          'Not approved in this rehearsal. Use run_tests to run the tests.',
        )),
      );
    await sleep(500);
  }
  const toReviewMs = rec.ms;
  const base: Record<string, unknown> = {
    task: 'B',
    instruction: TASK_B,
    model: api.models.router?.active.trueforgeModel,
    toReviewMs,
    approvalsDenied: denied,
  };
  const declared = rec.tools.find((t) => t.name === 'declare_context')?.args;
  const hits = retrievalHits(rec);
  const session = api.review.current;
  if (!reviewed || !session) {
    if (!reviewed) await vscode.commands.executeCommand('swage.stop');
    const maxLag = lag.stop();
    rec.stop();
    save(
      id,
      {
        ...base,
        ok: false,
        summary: `no change set to review (run ${api.runState() ?? 'unknown'})`,
        runState: api.runState(),
        declared,
        retrievalHits: hits,
        maxEventLoopLagMs: maxLag,
      },
      rec,
    );
    await reset();
    return false;
  }
  const files = session
    .files()
    .map((f) => ({ path: f.path, kind: f.kind, blocks: f.blocks.length }));
  await vscode.commands.executeCommand('swage.review.acceptAll');
  const applied = await vscode.commands.executeCommand<ApplyCommandResult>('swage.review.apply', {
    confirmPending: false,
  });
  await waitFor(() => ['done', 'error', 'cancelled'].includes(api.runState() ?? ''), 5 * 60_000);
  const maxLag = lag.stop();
  const diffStat = git('diff', '--stat');
  const untracked = git('ls-files', '--others', '--exclude-standard');
  const diff = `${git('diff')}${untracked ? `\n\nNew files:\n${untracked}` : ''}`;
  const testCli = pytest('tests/test_cli.py');
  // No existing test may be lost (deleted, renamed or nested): a run that "passes" with fewer
  // tests is a failure, as a judge reading the diff would see.
  const lost = lostTests(
    'tests/test_cli.py',
    git('show', 'HEAD:tests/test_cli.py'),
    readFileSync(path.join(DIR, 'tests/test_cli.py'), 'utf8'),
  );
  const suite = pytest();
  const help = py(['-m', 'flask', '--help']).out;
  const appDir = mkdtempSync(path.join(tmpdir(), 'swage-b-app-'));
  writeFileSync(path.join(appDir, 'sample_app.py'), SAMPLE_APP);
  const cmd = py(['-m', 'flask', '--app', path.join(appDir, 'sample_app.py'), 'config']);
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(cmd.out) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  const masked =
    parsed !== undefined &&
    ['SECRET_KEY', 'DATABASE_PASSWORD', 'API_TOKEN', 'STRIPE_KEY'].every(
      (k) => parsed?.[k] === '***',
    ) &&
    parsed['GREETING'] === 'hello';
  const touched = files.length;
  const ok =
    applied.ok &&
    touched >= 3 &&
    testCli.ok &&
    lost.length === 0 &&
    /\bconfig\b/.test(help) &&
    masked;
  let undo: string | undefined;
  if (!opts.keep) {
    const u = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    undo = u.ok ? 'restored' : u.error.code;
  }
  rec.stop();
  save(
    id,
    {
      ...base,
      ok,
      summary: `${touched} file(s) [${files.map((f) => f.path).join(', ')}], test_cli ${testCli.summary}, existing tests lost: ${lost.length === 0 ? 'none' : lost.join(', ')}, help lists config: ${/\bconfig\b/.test(help)}, masked: ${masked}`,
      files,
      filesNamedInInstruction: false,
      declared,
      retrievalHits: hits,
      applied: applied.ok,
      runStateAfter: api.runState(),
      diffStat,
      diff,
      testCli,
      testsSuite: suite,
      helpListsConfig: /\bconfig\b/.test(help),
      lostTests: lost,
      commandOutput: cmd.out.slice(0, 3000),
      masked,
      maxEventLoopLagMs: maxLag,
      undo,
      gitStatusAfter: opts.keep ? '(kept for the double undo)' : status(),
    },
    rec,
  );
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Task C: the primary becomes unreachable mid-task

/**
 * A stand-in primary endpoint that dies in the middle of its first answer: it accepts the
 * request, streams the start of a reply, drops the connection and stops listening, so every
 * later request is refused. TrueForge reaches it as an ordinary OpenAI-compatible provider.
 */
function dyingEndpoint(): Promise<{
  url: string;
  requests: number;
  close(): void;
  server: Server;
}> {
  return new Promise((resolve) => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (content: string): string =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'primary', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`;
        res.write(chunk('Looking at '));
        setTimeout(() => {
          res.write(chunk('get_debug_flag'));
          setTimeout(() => {
            req.socket.destroy(); // the endpoint goes away mid-answer
            server.close();
            server.closeAllConnections();
          }, 300);
        }, 300);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        get requests() {
          return requests;
        },
        close: () => {
          server.close();
          server.closeAllConnections();
        },
        server,
      });
    });
  });
}

async function setModels(models: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration('swage')
    .update('models', models, vscode.ConfigurationTarget.Workspace);
  const want = (models as { trueforgeModel: string }[])[0]?.trueforgeModel;
  await waitFor(() => api.models.router?.primary.trueforgeModel === want, 10_000);
}

/** The statement's Task C: an endpoint that is unreachable from the start (a closed local port). */
function closedEndpoint(): Promise<{ url: string; requests: number; close(): void }> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() =>
        resolve({ url: `http://127.0.0.1:${port}/v1`, requests: 0, close: () => undefined }),
      );
    });
  });
}

async function taskC(
  id: string,
  original: unknown,
  mode: 'unreachable' | 'mid-task',
): Promise<boolean> {
  await reset();
  const endpoint = mode === 'unreachable' ? await closedEndpoint() : await dyingEndpoint();
  const sdk = new TrueForge({ baseUrl: TRUEFORGE, timeoutInSeconds: 30 });
  await sdk.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'custom',
      name: 'swage-relay',
      baseUrl: endpoint.url,
      models: [
        {
          name: 'primary',
          modelId: 'primary',
          properties: { contextLength: 32768, maxOutputTokens: 4096 },
        },
      ],
    },
  });
  await setModels([
    {
      name: 'primary',
      label: 'the primary',
      trueforgeModel: 'swage-relay/primary',
      timeouts: { connectMs: 5000, firstTokenMs: 15000, stallMs: 10000 },
    },
    { name: 'fallback-1', trueforgeModel: FALLBACK },
  ]);
  api.models.router?.setActive('primary');
  await selectGetDebugFlag();
  const rec = new Recorder();
  const lag = lagMonitor();
  const result = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
    instruction: TASK_A,
  });
  const maxLag = lag.stop();
  const toDiff = rec.ms;
  const active = api.models.router?.active.name;
  const primaryFailure = api.models.router?.lastFailure('primary')?.failure;
  let rejected = false;
  let blocks = 0;
  if (result.kind === 'review' && api.review.current) {
    blocks = api.review.current.preview(HELPERS).blocks.length;
    rejected = await vscode.commands.executeCommand<boolean>('swage.review.rejectFile', {
      path: HELPERS,
    });
    await vscode.commands.executeCommand('swage.review.discard');
  }
  const st = status();
  rec.stop();
  endpoint.close();
  await sdk.settings.modelProviders.delete('swage-relay').catch(() => undefined);
  await setModels(original);
  api.models.router?.setActive(api.models.router.primary.name);
  const ok =
    result.kind === 'review' &&
    rec.switches.length > 0 &&
    active === 'fallback-1' &&
    rejected &&
    st === '';
  save(
    id,
    {
      task: 'C',
      instruction: TASK_A,
      ok,
      summary: `${rec.switches[0] ?? 'no switch'}; ${result.kind}; Reject all; git status ${st === '' ? 'clean' : 'DIRTY'}; max lag ${maxLag} ms`,
      primary:
        mode === 'unreachable'
          ? 'swage-relay/primary (TrueForge provider on a closed local port: unreachable from the start, as in the statement)'
          : 'swage-relay/primary (a local endpoint that drops the connection mid-answer, then refuses)',
      mode,
      fallback: FALLBACK,
      primaryRequests: endpoint.requests,
      primaryFailure,
      activeAfter: active,
      outcome: result.kind,
      blocks,
      startToDiffMs: toDiff,
      rejectedAll: rejected,
      maxEventLoopLagMs: maxLag,
      gitStatusAfter: st,
    },
    rec,
  );
  return ok;
}

// ---------------------------------------------------------------------------------------------

suite('Swage rehearsal on Flask 3.1.3', function () {
  this.timeout(0);
  let original: unknown;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    api = (await ext.activate()) as SwageTestApi;
    assert.ok(api, 'SWAGE_TEST_API must be 1');
    assert.ok(DIR.length > 0, 'open the Flask clone');
    original = vscode.workspace.getConfiguration('swage').inspect('models')?.workspaceValue;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      path.join(OUT, 'meta.json'),
      `${JSON.stringify({ startedAt: new Date().toISOString(), flaskHead: git('rev-parse', 'HEAD'), profiles: api.models.router?.profiles.map((p) => ({ name: p.name, model: p.trueforgeModel, kind: p.kind })), tasks: [...TASKS], runs: { a: RUNS_A, b: RUNS_B, c: RUNS_C } }, null, 2)}\n`,
    );
    await reset();
    process.stdout.write(
      `Rehearsal on ${clean(DIR)} (HEAD ${git('rev-parse', '--short', 'HEAD')}), evidence in ${clean(OUT)}\n`,
    );
  });

  suiteTeardown(async () => {
    await reset();
  });

  test('A0: cancel during the Task A instruction (before Task A)', async () => {
    if (!TASKS.has('cancel')) return;
    await cancelDemo('cancel-1');
  });

  test('Task A: inline edit, per-block review, apply, verify, undo', async () => {
    if (!TASKS.has('a')) return;
    const keepLast = TASKS.has('undo');
    const n = keepLast ? RUNS_A - 1 : RUNS_A;
    for (let i = 1; i <= n; i++) await taskA(`a-${i}`, { toggle: i === 1 && TASKS.has('toggle') });
  });

  test('Task B: agent mode on files it finds itself, apply, tests', async () => {
    if (!TASKS.has('b')) return;
    const n = TASKS.has('undo') ? RUNS_B - 1 : RUNS_B;
    for (let i = 1; i <= n; i++) {
      // A minute between runs lets a free tier's input-tokens-per-minute limit recover.
      if (i > 1) await sleep(60_000);
      await taskB(`b-${i}`);
    }
  });

  test('Double undo: Task A and Task B applied, then Undo twice', async () => {
    if (!TASKS.has('undo')) return;
    await reset();
    const a = await taskA(`a-${TASKS.has('a') ? RUNS_A : 1}`, { keep: true });
    const b = await taskB(`b-${TASKS.has('b') ? RUNS_B : 1}`, { keep: true });
    const before = git('status', '--porcelain');
    const u1 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    const afterFirst = git('status', '--porcelain');
    const u2 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    const afterSecond = git('status', '--porcelain');
    const u3 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    save('undo-1', {
      task: 'undo',
      ok: u1.ok && u2.ok && afterSecond === '' && !u3.ok,
      summary: `A applied: ${a}, B applied: ${b}; undo 1 ${u1.ok ? 'ok' : u1.error.code}, undo 2 ${u2.ok ? 'ok' : u2.error.code}, git status after: ${afterSecond === '' ? 'clean' : 'DIRTY'}; third undo: ${u3.ok ? 'ok' : u3.error.code}`,
      statusBefore: before,
      statusAfterFirstUndo: afterFirst,
      statusAfterSecondUndo: afterSecond,
      thirdUndo: u3.ok ? 'ok' : u3.error.code,
    });
  });

  test('Task C: the primary becomes unreachable mid-task; automatic fallback; Reject all', async () => {
    if (!TASKS.has('c')) return;
    // Run 1 is the statement's own wording (an unreachable endpoint configured before Task A);
    // the rest make the primary fail in the middle of its answer.
    for (let i = 1; i <= RUNS_C; i++)
      await taskC(`c-${i}`, original, i === 1 ? 'unreachable' : 'mid-task');
  });
});
