import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SwageClient, type SdkLike } from '../client/client';
import { agentNameFor, type ModelProfile } from '../client/manifest';
import { profilesFrom, type ResolvedProfile } from '../resilience/profiles';
import { formatReport, loadManifests, runSetup } from '../client/setup';
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
import { EventRelay } from './relay';
import { AgentRun } from './run';

/**
 * The VS Code side of agent mode: the panel's webview provider and the runtime it needs. The
 * runtime (index, MCP server, TrueForge, agent registration) starts on the first request, so
 * activation stays fast. Nothing is stored in the workspace: the index cache lives in global storage.
 */

export const AGENT_VIEW_ID = 'swage.agentView';

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
  readonly watcher: vscode.Disposable;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

export class AgentController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private runtime: Promise<Runtime> | undefined;
  private ready: Runtime | undefined;
  private run: AgentRun | undefined;
  private readonly logger: Logger;
  /** Test hook: replaces TrueForge with a scripted SDK (set only by the integration tests). */
  sdkFactory: ((mcp: { url: string; token: string }) => SdkLike) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly review?: ReviewController,
  ) {
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

  private post(msg: HostToWebview): void {
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
        const s = this.settings();
        this.post({
          type: 'init',
          workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? 'no folder',
          model: s.profiles[0]?.trueforgeModel ?? 'no model configured',
        });
        return;
      }
      case 'submit':
        await this.start(msg.text);
        return;
      case 'retry':
        if (this.run && !this.isBusy()) await this.start(this.run.request);
        return;
      case 'stop':
        await this.stop();
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
  async start(prompt: string): Promise<void> {
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
    this.run = new AgentRun({
      client: rt.client,
      ctx: rt.ctx,
      relay: rt.relay,
      approvals: rt.approvals,
      agentName: rt.agentName,
      view: { post: (m) => this.post(m) },
      budgets: rt.budgets,
      logger: this.logger,
      ...(this.review
        ? {
            review: (taskId: string, changeSet: Parameters<ReviewController['start']>[1]) =>
              new Promise<{ applied: boolean; message: string }>((resolve) => {
                void this.review?.start(taskId, changeSet, (outcome) => resolve(outcome));
              }),
          }
        : {}),
    });
    await this.trackBusy(this.run.start(prompt));
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

  private async createRuntime(): Promise<Runtime> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a folder first: Swage works on a workspace folder.');
    const root = folder.uri.fsPath;
    const s = this.settings();
    const profile = s.profiles[0];
    if (!profile)
      throw new Error(
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
    const report = await runSetup({
      client,
      profiles: [profile],
      manifests: loadManifests(path.join(this.context.extensionPath, 'trueforge', 'agents')),
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
