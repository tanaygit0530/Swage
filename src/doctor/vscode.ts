import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentController, Runtime } from '../agent/controller';
import { agentNameFor } from '../client/manifest';
import { probeProfile } from '../resilience/probe';
import type { ModelsController } from '../resilience/vscode/models';
import { redactText } from '../safety/redact';
import { TRUEFORGE_VERSION } from '../supervisor/pin';
import { doctorMarkdown, runDoctor, summary, type CheckResult, type CommandResult } from './checks';

/**
 * "Swage: Doctor" in VS Code (blueprint F8): runs the checks with real probes and opens the
 * report as a Markdown preview. The report is written to global storage, never the workspace.
 */

function run(cmd: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 15_000, cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: redactText(`${stdout}${stderr}`).trim() });
    });
  });
}

async function healthz(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { status?: string; version?: string };
    return body.status === 'ok' ? (body.version ?? 'unknown') : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON-RPC initialize against Swage's MCP server, with or without the bearer token. */
async function mcpStatus(url: string, token: string | undefined): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'swage-doctor', version: '0' },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}

export class DoctorController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** The last report, for tests. */
  last: CheckResult[] | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agent: AgentController,
    private readonly models: ModelsController,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.commands.registerCommand('swage.doctor', (opts?: { show?: boolean }) =>
        this.run(opts?.show !== false),
      ),
    );
  }

  async run(show = true): Promise<CheckResult[]> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const url = vscode.workspace
      .getConfiguration('swage')
      .get<string>('truefoundry.baseUrl', 'http://localhost:8790');
    let runtime: Promise<Runtime> | undefined;
    const rt = (): Promise<Runtime> => (runtime ??= this.agent.runtimeReady());
    const venv = (dir: string): string[] =>
      process.platform === 'win32'
        ? [
            path.join(dir, '.venv', 'Scripts', 'python.exe'),
            path.join(dir, 'venv', 'Scripts', 'python.exe'),
          ]
        : [path.join(dir, '.venv', 'bin', 'python'), path.join(dir, 'venv', 'bin', 'python')];
    // VS Code ships ripgrep as @vscode/ripgrep (older builds) or @vscode/ripgrep-universal.
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rg = ['node_modules', 'node_modules.asar.unpacked']
      .flatMap((d) => [
        path.join(vscode.env.appRoot, d, '@vscode', 'ripgrep', 'bin', exe),
        path.join(
          vscode.env.appRoot,
          d,
          '@vscode',
          'ripgrep-universal',
          'bin',
          `${process.platform}-${process.arch}`,
          exe,
        ),
      ])
      .find((p) => existsSync(p));

    const results = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Swage: Doctor',
        cancellable: false,
      },
      (progress) => {
        progress.report({ message: 'checking Node, TrueForge, the MCP server and each model…' });
        return runDoctor({
          profiles: this.models.router?.profiles ?? [],
          trueforgeUrl: url,
          pinnedVersion: TRUEFORGE_VERSION,
          run: (cmd, args) => run(cmd, args, folder),
          trueforgeVersion: () => healthz(url),
          mcpToolsViaTrueForge: async () => (await rt()).client.listMcpTools('editor-tools'),
          mcpDirect: async () => {
            const r = await rt();
            const withToken = await mcpStatus(r.server.url, r.server.token);
            const without = await mcpStatus(r.server.url, undefined);
            return {
              withToken: withToken >= 200 && withToken < 300,
              withoutTokenRefused: without === 401,
            };
          },
          ensureAgents: async (p) => {
            const r = await rt();
            const names = ['swage-main', 'swage-inline'].map((b) => agentNameFor(b, p));
            for (const n of names) await r.prepareAgent(p, n);
            return names;
          },
          probe: async (p) => {
            progress.report({ message: `asking ${p.label} for a tool call…` });
            return probeProfile((await rt()).client, p, { toolCall: true });
          },
          pythonCandidates: [
            ...(folder ? venv(folder).filter((p) => existsSync(p)) : []),
            ...(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']),
          ],
          workspaceTrusted: vscode.workspace.isTrusted,
          ...(rg ? { bundledRipgrep: rg } : {}),
        });
      },
    );
    this.last = results;
    const text = doctorMarkdown(results);
    this.output.appendLine(`Doctor: ${summary(results)}`);
    for (const r of results)
      this.output.appendLine(
        `  ${r.status.padEnd(4)} ${r.title}: ${r.detail}${r.fix && r.status !== 'pass' ? ` (fix: ${r.fix})` : ''}`,
      );
    const dir = this.context.globalStorageUri.fsPath;
    await fsp.mkdir(dir, { recursive: true });
    const file = vscode.Uri.file(path.join(dir, 'doctor.md'));
    await fsp.writeFile(file.fsPath, text);
    if (show) await vscode.commands.executeCommand('markdown.showPreview', file);
    const failed = results.filter((r) => r.status === 'fail').length;
    const message = `Swage Doctor: ${summary(results)}.`;
    if (failed > 0) void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
    return results;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
