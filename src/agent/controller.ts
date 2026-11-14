import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SwageClient, type SdkLike } from '../client/client';
import { agentNameFor, type ModelProfile } from '../client/manifest';
import { profilesFrom, type ResolvedProfile } from '../resilience/profiles';
import {
  agentPreparer,
  formatReport,
  loadManifests,
  PLAN_AGENT_BASE,
  runSetup,
} from '../client/setup';
import type { ModelsController } from '../resilience/vscode/models';
import { Bm25Searcher } from '../context/bm25';
import { resolveBudgets, type Budgets } from '../context/budget';
import { WorkspaceIndex, type IndexCache } from '../context/indexer';
import { mentionCompletions } from '../context/mentions';
import { createParser } from '../context/symbols';
import { ApprovalList, createToolContext, type ToolContext } from '../mcp/context';
import { startEditorToolsServer, type EditorToolsServer } from '../mcp/server';
import { EDITOR_TOOLS } from '../mcp/tools/index';
import {
  redactingLogger,
  shutdownInOrder,
  TrueForgeSupervisor,
  type Logger,
} from '../supervisor/supervisor';
import type { ReviewController } from '../review/vscode/controller';
import { parseWebviewMessage, type HostToWebview, type WebviewToHost } from '../ui/protocol';
import { changeRows } from '../ui/changes';
import { EventRelay } from './relay';
import type { SwageEvent } from '../client/events';
import { AgentRun, type AgentRunOptions } from './run';

/**
 * The VS Code side of agent mode: the panel's webview provider and the runtime it needs. The
 * runtime (index, MCP server, TrueForge, agent registration) starts on the first request, so
 * activation stays fast. Nothing is stored in the workspace: the index cache lives in global storage.
 */

export const AGENT_VIEW_ID = 'swage.agentView';

/** workspaceState keys: the run mode and the model chosen in the panel, per workspace. */
const MODE_KEY = 'swage.panel.mode';
export const MODEL_KEY = 'swage.panel.model';
/** At most this much selected text is attached by "+". */
const ATTACH_CHARS = 4_000;

export interface Runtime {
  readonly root: string;
  readonly ctx: ToolContext;
  readonly relay: EventRelay;
  readonly approvals: ApprovalList;
  readonly index: WorkspaceIndex;
  readonly server: EditorToolsServer;
  readonly supervisor: TrueForgeSupervisor;
  readonly client: SwageClient;
  readonly agentName: string;
  /** The inline-edit agent for the same profile (declare_context and stage_edit only). */
  readonly inlineAgentName: string;
  readonly profile: ModelProfile;
  readonly budgets: Budgets;
  /** Upserts a profile's agent on first use (fallback profiles are prepared lazily). */
  readonly prepareAgent: (profile: ModelProfile, agentName: string) => Promise<void>;
  readonly watcher: vscode.Disposable;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/** One event of a run, as seen by onRunEvent listeners. */
export type RunEventRecord =
  | { readonly kind: 'agent' | 'inline'; readonly event: SwageEvent }
  | { readonly kind: 'agent' | 'inline'; readonly switched: string };

export class AgentController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private runtime: Promise<Runtime> | undefined;
  private ready: Runtime | undefined;
  private readonly eventListeners = new Set<(e: RunEventRecord) => void>();
  private run: AgentRun | undefined;
  private readonly logger: Logger;
  /** Test hook: replaces TrueForge with a scripted SDK (set only by the integration tests). */
  sdkFactory: ((mcp: { url: string; token: string }) => SdkLike) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly review?: ReviewController,
    private readonly models?: ModelsController,
  ) {
    // Keep the panel's model picker in step with Switch Model, the status bar and fallbacks.
    models?.onDidChange(() => this.postModels());
    models?.onRecovered((p) => this.post({ type: 'recovered', name: p.name, label: p.label }));
    // Keep the files-changed bar in step with every review decision, wherever it was made.
    review?.onDidChange(() => this.postReviewChanges());
    this.logger = redactingLogger({
      info: (m) => output.appendLine(m),
      warn: (m) => output.appendLine(`warn: ${m}`),
      error: (m) => output.appendLine(`error: ${m}`),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview-style.css'));
    const n = nonce();
    view.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${n}'; font-src ${view.webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>Swage agent</title>
</head>
<body><div id="root"></div><script nonce="${n}" src="${script.toString()}"></script></body>
</html>`;
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) {
        this.logger.warn('Ignored a malformed message from the agent panel.');
        return;
      }
      void this.onMessage(msg);
    });
  }

  /** The model picker's list: every profile, the active one, and recent failures. */
  private postModels(): void {
    const router = this.models?.router;
    if (!router) return;
    this.post({
      type: 'models',
      active: router.active.name,
      items: router.profiles.map((p) => {
        const failed = router.lastFailure(p.name)?.failure.reason;
        return {
          name: p.name,
          label: p.label,
          model: p.trueforgeModel,
          ...(failed ? { note: failed } : {}),
        };
      }),
      autoFallback: router.profiles.length > 1,
    });
  }

  private modelRestored = false;

  /** The model last picked in this workspace's panel, once per session (if it still exists). */
  private restoreModel(): void {
    const router = this.models?.router;
    if (this.modelRestored || !router) return;
    this.modelRestored = true;
    const name = this.context.workspaceState.get<string>(MODEL_KEY);
    if (name && router.profiles.some((p) => p.name === name)) router.setActive(name);
  }

  /** Planning or Fast, remembered per workspace. */
  get mode(): 'planning' | 'fast' {
    return this.context.workspaceState.get<'planning' | 'fast'>(MODE_KEY) ?? 'planning';
  }

  private pendingFocus = false;

  /** Cmd+L / Ctrl+L: show the agent panel and put the cursor in its composer. */
  async focusComposer(): Promise<void> {
    await this.focus();
    if (this.view) this.post({ type: 'focusComposer' });
    else this.pendingFocus = true;
  }

  /** "+": the selection as a mention plus a fenced snippet, or the active file as a mention. */
  private attachment(what: 'auto' | 'file' | 'selection'): string | undefined {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const sel = editor.selection;
    if (what !== 'file' && !sel.isEmpty) {
      const text = editor.document.getText(sel);
      const clipped = text.length > ATTACH_CHARS ? `${text.slice(0, ATTACH_CHARS)}\n…` : text;
      return `@file:${rel} (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`${editor.document.languageId}\n${clipped}\n\`\`\`\n`;
    }
    return `@file:${rel} `;
  }

  /** The phase the files-changed bar shows, so a finished review empties it exactly once. */
  private barPhase: 'none' | 'staging' | 'review' = 'none';

  /** Each agent turn's request, for the per-turn cards and the bar's "For this turn". */
  private readonly turnLabels = new Map<string, string>();
  /** The newest turn that reached review. */
  private latestTurn: string | undefined;

  private postTurns(): void {
    const review = this.review;
    if (!review) return;
    const items = review
      .turns()
      .filter((t) => this.turnLabels.has(t.taskId))
      .map((t) => ({
        taskId: t.taskId,
        label: (this.turnLabels.get(t.taskId) ?? '').slice(0, 120),
        files: t.files,
        open: t.open,
      }));
    const current = review.current?.taskId;
    this.post({
      type: 'turns',
      ...(current && this.turnLabels.has(current) ? { current } : {}),
      ...(this.latestTurn ? { latest: this.latestTurn } : {}),
      items,
    });
  }

  /** The files-changed bar for the agent-mode review in progress (inline reviews stay in the editor). */
  private postReviewChanges(): void {
    this.postTurns();
    const session = this.review?.current;
    if (session && this.review?.mode.mode === 'agent') {
      const declared = session.changeSet.declaredContext;
      const reasons = new Map((declared?.files ?? []).map((f) => [f.path, f.reason]));
      this.post({
        type: 'changes',
        phase: 'review',
        files: changeRows(
          session.files(),
          (p) => session.base(p),
          reasons,
          (p) => {
            const s = session.status(p);
            return s === 'applied' || s === 'discarded' ? s : undefined;
          },
        ),
      });
    } else if (this.barPhase === 'review') {
      this.post({ type: 'changes', phase: 'none', files: [] });
    }
  }

  private readonly postListeners = new Set<(msg: HostToWebview) => void>();

  /** Every message posted to the panel (tests). */
  onPanelPost(listener: (msg: HostToWebview) => void): vscode.Disposable {
    this.postListeners.add(listener);
    return new vscode.Disposable(() => this.postListeners.delete(listener));
  }

  /** Handles a panel message as if the webview had sent it (tests). */
  async panelMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (msg) await this.onMessage(msg);
  }

  private post(msg: HostToWebview): void {
    for (const l of [...this.postListeners]) l(msg);
    if (msg.type === 'changes') this.barPhase = msg.phase;
    void this.view?.webview.postMessage(msg);
  }

  private settings(): {
    profiles: ResolvedProfile[];
    budgets: Budgets;
    baseUrl: string;
    autoStart: boolean;
    ignore: string[];
  } {
    const c = vscode.workspace.getConfiguration('swage');
    return {
      profiles: this.profiles(c.get<unknown>('models', [])),
      budgets: resolveBudgets(c.get('budgets')),
      baseUrl: c.get<string>('truefoundry.baseUrl', 'http://localhost:8790'),
      autoStart: c.get<boolean>('autoStart', true),
      ignore: c.get<string[]>('ignore', []),
    };
  }

  /** Profiles from swage.models, else the profiles file of a development checkout; [] if invalid. */
  private profiles(setting: unknown): ResolvedProfile[] {
    try {
      return profilesFrom(setting, this.context.extensionPath);
    } catch (err) {
      this.logger.warn((err as Error).message);
      return [];
    }
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.restoreModel();
        const s = this.settings();
        this.post({
          type: 'init',
          workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? 'no folder',
          model: this.models?.router
            ? `${this.models.router.active.label} (${this.models.router.active.trueforgeModel})`
            : (s.profiles[0]?.trueforgeModel ?? 'no model configured'),
          mode: this.mode,
        });
        this.postModels();
        if (this.pendingFocus) {
          this.pendingFocus = false;
          this.post({ type: 'focusComposer' });
        }
        return;
      }
      case 'setMode':
        await this.context.workspaceState.update(MODE_KEY, msg.mode);
        this.post({ type: 'mode', mode: msg.mode });
        return;
      case 'attach': {
        const text = this.attachment(msg.what);
        if (text === undefined)
          this.post({
            type: 'notice',
            tone: 'info',
            message: 'Open a file in the editor first; "+" attaches its selection or the file.',
          });
        else this.post({ type: 'attachment', text });
        return;
      }
      case 'selectModel': {
        const router = this.models?.router;
        if (router?.setActive(msg.name)) {
          await this.context.workspaceState.update(MODEL_KEY, msg.name);
          void vscode.window.setStatusBarMessage(
            `Swage will use ${router.active.label} for the next request.`,
            4000,
          );
        }
        this.postModels();
        return;
      }
      case 'moreModels':
        await vscode.commands.executeCommand('swage.switchModel');
        this.postModels();
        return;
      case 'submit':
        await this.start(msg.text);
        return;
      case 'retry':
        if (this.run && !this.isBusy()) await this.start(this.run.request);
        return;
      case 'stop':
        await this.stop();
        return;
      case 'planDecision':
        await this.trackBusy(this.run?.decidePlan(msg.toolCallId, msg.approve, msg.feedback));
        return;
      case 'approve': {
        // The change-set card is decided in the Review view: Approve applies, Deny discards.
        if (this.run?.isReviewCall(msg.toolCallId)) {
          await vscode.commands.executeCommand(
            msg.allow ? 'swage.review.apply' : 'swage.review.discard',
          );
          return;
        }
        const pending = this.run?.decide(msg.toolCallId, msg.allow, msg.reason);
        await this.trackBusy(pending);
        return;
      }
      case 'openFile':
        await this.openWorkspaceFile(msg.path, msg.line);
        return;
      case 'openDiff':
        await vscode.commands.executeCommand('swage.review.openFile', {
          path: msg.path,
          ...(msg.blockId === undefined ? {} : { blockId: msg.blockId }),
        });
        return;
      case 'reviewAction':
        await vscode.commands.executeCommand(`swage.review.${msg.action}`, {
          path: msg.path,
          ...(msg.blockId === undefined ? {} : { blockId: msg.blockId }),
        });
        return;
      case 'reviewTurn':
        if (!(await this.review?.resumeTurn(msg.taskId)))
          this.post({
            type: 'notice',
            tone: 'info',
            message: 'That turn has no changes left to review: they were applied or discarded.',
          });
        return;
      case 'acceptAll':
      case 'applyAccepted': {
        if (!this.review?.current) return;
        if (msg.type === 'acceptAll') this.review.decideAll('accept');
        // The existing atomic apply with hash checks; pending blocks are left out on purpose.
        const r = await this.review.apply({ confirmPending: false });
        if (r.ok)
          this.post({
            type: 'applied',
            files: r.files.length,
            message: `Applied ${r.files.length} file(s)`,
          });
        else
          this.post({
            type: 'notice',
            tone: r.reason === 'conflict' ? 'warning' : 'info',
            message: r.message,
          });
        return;
      }
      case 'rejectAll':
        if (await this.review?.discard())
          this.post({
            type: 'notice',
            tone: 'info',
            message: 'Rejected all changes. The workspace is unchanged.',
          });
        return;
      case 'undo':
        await vscode.commands.executeCommand('swage.undoLastChangeSet');
        return;
      case 'openSymbol':
        await this.openSymbol(msg.name);
        return;
      case 'insertCode': {
        const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
        if (!editor) {
          void vscode.window.showInformationMessage('Open a file to insert the code into.');
          return;
        }
        await editor.edit((b) => b.replace(editor.selection, msg.text));
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard.', 2000);
        return;
      case 'complete': {
        const rt = await this.runtime?.catch(() => undefined);
        const items = rt ? mentionCompletions(rt.index, msg.query, 12) : [];
        this.post({
          type: 'completions',
          requestId: msg.requestId,
          items: items.map(({ kind, label, detail, insertText }) => ({
            kind,
            label,
            detail,
            insertText,
          })),
        });
        return;
      }
    }
  }

  /**
   * Opens a workspace file from a chip or card. Only plain relative paths inside the workspace;
   * a bare name the model shortened (cli.py) is looked up by name.
   */
  private async openWorkspaceFile(file: string, line?: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const clean = file.replace(/^\.\//, '');
    if (!folder || !/^[\w./-]+$/.test(clean) || clean.split('/').includes('..')) return;
    let uri = vscode.Uri.joinPath(folder.uri, clean);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const found = await vscode.workspace.findFiles(
        `**/${clean}`,
        '**/{node_modules,.git,.venv,venv}/**',
        1,
      );
      if (!found[0]) {
        void vscode.window.showWarningMessage(`Swage: ${clean} is not in the workspace.`);
        return;
      }
      uri = found[0];
    }
    const at = line === undefined ? undefined : new vscode.Range(line - 1, 0, line - 1, 0);
    await vscode.window.showTextDocument(uri, { preview: true, ...(at ? { selection: at } : {}) });
  }

  private async openSymbol(name: string): Promise<void> {
    const short = name.split('.').pop() ?? name;
    const symbols =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        short,
      )) ?? [];
    const hit = symbols.find((s) => s.name === short) ?? symbols[0];
    if (!hit) {
      void vscode.window.showInformationMessage(`Swage: no definition of ${name} found.`);
      return;
    }
    await vscode.window.showTextDocument(hit.location.uri, {
      preview: true,
      selection: hit.location.range,
    });
  }

  /** True while an agent run is starting or streaming. */
  get busy(): boolean {
    return this.isBusy();
  }

  /** The shared runtime (index, MCP server, TrueForge, agents); the inline edit uses it too. */
  runtimeReady(): Promise<Runtime> {
    return this.ensureRuntime().catch((err: unknown) => {
      this.runtime = undefined;
      throw err;
    });
  }

  /** The Swage output channel's logger (redacting). */
  get log(): Logger {
    return this.logger;
  }

  private isBusy(): boolean {
    const s = this.run?.state;
    return s === 'starting' || s === 'running';
  }

  private async trackBusy(outcome: Promise<unknown> | undefined): Promise<void> {
    if (!outcome) return;
    await vscode.commands.executeCommand('setContext', 'swage.running', true);
    try {
      await outcome;
    } finally {
      await vscode.commands.executeCommand('setContext', 'swage.running', this.isBusy());
    }
  }

  /** Starts an agent run for a request. Only one run at a time (blueprint section 8). */
  async start(prompt: string, mode: 'planning' | 'fast' = this.mode): Promise<void> {
    if (this.isBusy()) {
      this.post({ type: 'error', message: 'A run is in progress. Stop it first.' });
      return;
    }
    let rt: Runtime;
    try {
      this.post({
        type: 'status',
        state: 'starting',
        message: 'Starting TrueForge and the editor tools…',
      });
      rt = await this.ensureRuntime();
    } catch (err) {
      this.runtime = undefined;
      this.post({
        type: 'status',
        state: 'error',
        message: (err as Error).message.split('\n')[0] ?? 'Could not start',
      });
      return;
    }
    // Planning mode runs the plan variant of the main agent (declare_context needs approval).
    const base = mode === 'planning' ? PLAN_AGENT_BASE : 'swage-main';
    let agentName = rt.agentName;
    if (base === PLAN_AGENT_BASE && !this.models?.router) {
      agentName = agentNameFor(PLAN_AGENT_BASE, rt.profile);
      try {
        await rt.prepareAgent(rt.profile, agentName);
      } catch (err) {
        this.post({ type: 'status', state: 'error', message: (err as Error).message });
        return;
      }
    }
    this.run = new AgentRun({
      client: rt.client,
      ctx: rt.ctx,
      relay: rt.relay,
      approvals: rt.approvals,
      agentName,
      view: { post: (m) => this.post(m) },
      budgets: rt.budgets,
      logger: this.logger,
      ...this.resilience(rt, base),
      onStaged: (taskId, changeSet, path) => this.review?.watch(taskId, changeSet, [path]),
      onDropped: (taskId) => this.review?.unwatch(taskId),
      ...(this.review
        ? {
            review: (taskId: string, changeSet: Parameters<ReviewController['start']>[1]) =>
              new Promise<{ applied: boolean; message: string }>((resolve) => {
                this.turnLabels.set(taskId, prompt);
                this.latestTurn = taskId;
                void this.review?.start(taskId, changeSet, (outcome) => resolve(outcome));
              }),
          }
        : {}),
    });
    await this.trackBusy(this.run.start(prompt));
  }

  /** Task id of the current (or last) agent run, for tests and the session log. */
  get runTaskId(): string | undefined {
    return this.run?.taskId;
  }

  /**
   * Answers every pending approval card except the change-set review (tests; the panel does
   * this one card at a time). Returns the names of the calls decided.
   */
  async decidePending(allow: boolean, reason?: string): Promise<string[]> {
    const run = this.run;
    if (!run) return [];
    const calls = run.pendingCalls.filter((c) => !run.isReviewCall(c.toolCallId));
    for (const c of calls) await this.trackBusy(run.decide(c.toolCallId, allow, reason));
    return calls.map((c) => c.name);
  }

  /** Answers the pending Plan card (tests). Returns false when no plan is waiting. */
  async decidePlan(approve: boolean, feedback?: string): Promise<boolean> {
    const run = this.run;
    const call = run?.pendingCalls.find((c) => c.name === 'declare_context');
    if (!run || !call) return false;
    await this.trackBusy(run.decidePlan(call.toolCallId, approve, feedback));
    return true;
  }

  /** State of the current run, for tests and the status bar. */
  get runState(): string | undefined {
    return this.run?.state;
  }

  async stop(): Promise<void> {
    await this.run?.cancel();
    await vscode.commands.executeCommand('setContext', 'swage.running', false);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${AGENT_VIEW_ID}.focus`);
  }

  private ensureRuntime(): Promise<Runtime> {
    this.runtime ??= this.createRuntime().then((rt) => (this.ready = rt));
    return this.runtime;
  }

  /** The runtime if it has finished starting, without waiting. */
  get readyRuntime(): Runtime | undefined {
    return this.ready;
  }

  /**
   * Fallback options for a run (blueprint section 8): the shared router, the agent base name and
   * the lazy agent upsert. Empty without a models controller (tests that pin one agent).
   */
  resilience(
    rt: Runtime,
    agentBase: 'swage-main' | 'swage-plan' | 'swage-inline',
  ): Pick<AgentRunOptions, 'router' | 'agentBase' | 'prepareAgent' | 'onSwitch' | 'onEvent'> {
    const kind = agentBase === 'swage-inline' ? 'inline' : 'agent';
    const onEvent = (event: SwageEvent): void => {
      for (const l of [...this.eventListeners]) l({ kind, event });
    };
    const router = this.models?.router;
    if (!router) return { onEvent };
    return {
      router,
      agentBase,
      prepareAgent: rt.prepareAgent,
      onSwitch: (d) => {
        for (const l of [...this.eventListeners]) l({ kind, switched: d.message });
        this.models?.notifySwitch(d);
      },
      onEvent,
    };
  }

  /** Every run event (agent and inline), for the session log and rehearsal evidence. */
  onRunEvent(listener: (e: RunEventRecord) => void): vscode.Disposable {
    this.eventListeners.add(listener);
    return new vscode.Disposable(() => this.eventListeners.delete(listener));
  }

  private async createRuntime(): Promise<Runtime> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a folder first: Swage works on a workspace folder.');
    const root = folder.uri.fsPath;
    const s = this.settings();
    const profile = this.models?.router?.active ?? s.profiles[0];
    if (!profile)
      throw new Error(
        this.models?.problem ??
          'No model profile: add one to the swage.models setting (see config/models.example.yaml).',
      );

    const t0 = Date.now();
    const parser = await createParser({
      wasmDir: path.join(this.context.extensionPath, 'dist', 'wasm'),
      onFallback: (r) => this.logger.warn(`tree-sitter unavailable, using regex symbols: ${r}`),
    });
    const storage = this.context.globalStorageUri.fsPath;
    await fsp.mkdir(storage, { recursive: true });
    const cacheFile = path.join(
      storage,
      `index-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`,
    );
    const cache: IndexCache = {
      load: () => fsp.readFile(cacheFile, 'utf8').catch(() => undefined),
      save: (data) => fsp.writeFile(cacheFile, data),
    };
    const index = new WorkspaceIndex({ root, parser, cache, ignorePatterns: s.ignore });
    const stats = await index.build();
    this.logger.info(
      `index: ${stats.files} files (${stats.parsed} parsed, ${stats.reused} cached) in ${Math.round(stats.ms)} ms`,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*'),
    );
    const forward = (type: 'create' | 'change' | 'delete') => (uri: vscode.Uri) =>
      void index.handleEvent({ type, path: uri.fsPath });
    const subs = [
      watcher.onDidCreate(forward('create')),
      watcher.onDidChange(forward('change')),
      watcher.onDidDelete(forward('delete')),
      watcher,
    ];

    const relay = new EventRelay();
    const approvals = new ApprovalList();
    const ctx = createToolContext({
      root,
      index,
      searcher: new Bm25Searcher(index),
      budgets: s.budgets,
      ignorePatterns: s.ignore,
      approvals,
      events: relay,
      logger: this.logger,
    });
    const server = await startEditorToolsServer({ context: ctx, tools: EDITOR_TOOLS });

    const supervisor = new TrueForgeSupervisor({
      sqlitePath: path.join(homedir(), 'trueforge-data', 'trueforge.sqlite'),
      reuseUrl: s.baseUrl,
      logger: this.logger,
    });
    let baseUrl: string;
    let client: SwageClient;
    if (this.sdkFactory) {
      baseUrl = 'scripted (tests)';
      client = new SwageClient({
        baseUrl: 'http://swage-test.invalid',
        sdk: this.sdkFactory({ url: server.url, token: server.token }),
      });
    } else if (s.autoStart) {
      baseUrl = await supervisor.start();
    } else {
      const version = await supervisor.health(s.baseUrl);
      if (version === undefined) {
        await server.stop();
        throw new Error(
          `TrueForge is not running at ${s.baseUrl}. Start it with trueforge/start.sh, or enable swage.autoStart.`,
        );
      }
      baseUrl = s.baseUrl;
    }
    client ??= new SwageClient({ baseUrl });
    const manifests = loadManifests(path.join(this.context.extensionPath, 'trueforge', 'agents'));
    // With fallback, agents are upserted per profile on first use, so a primary model that
    // TrueForge does not know falls back instead of blocking the start.
    const report = await runSetup({
      client,
      profiles: this.models?.router ? [] : [profile],
      manifests,
      mcp: { url: server.url, bearerToken: server.token },
    });
    for (const line of formatReport(report)) this.logger.info(line);
    if (report.mcp.status === 'error' || report.agents.some((a) => a.result === 'error')) {
      throw new Error(
        `TrueForge setup failed: ${formatReport(report).find((l) => /FAILED|error/.test(l)) ?? 'see the Swage output'}`,
      );
    }
    this.logger.info(
      `runtime ready in ${Date.now() - t0} ms (TrueForge ${baseUrl}, MCP ${server.url})`,
    );
    this.models?.attach(client);
    return {
      root,
      ctx,
      relay,
      approvals,
      index,
      server,
      supervisor,
      client,
      agentName: agentNameFor('swage-main', profile),
      inlineAgentName: agentNameFor('swage-inline', profile),
      profile,
      budgets: s.budgets,
      prepareAgent: agentPreparer(client, manifests),
      watcher: vscode.Disposable.from(...subs),
    };
  }

  /** Stops TrueForge before the MCP server (upstream issue 878), then the watcher. */
  async shutdown(): Promise<void> {
    await this.run?.cancel();
    const rt = await this.runtime?.catch(() => undefined);
    if (!rt) return;
    rt.watcher.dispose();
    await rt.index.save().catch(() => undefined);
    await shutdownInOrder(rt.supervisor, rt.server);
  }

  /** Test hook: stops the runtime so the next request builds a new one (a new scripted SDK). */
  async resetRuntime(): Promise<void> {
    await this.shutdown();
    this.runtime = undefined;
    this.ready = undefined;
    this.run = undefined;
  }

  dispose(): void {
    void this.shutdown();
  }
}
