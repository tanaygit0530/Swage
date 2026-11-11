import * as vscode from 'vscode';
import { AGENT_VIEW_ID, AgentController } from './agent/controller';
import { COMMANDS, RUNNING_CONTEXT_KEY, stubMessage } from './commands';

let controller: AgentController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const started = performance.now();
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);
  const output = vscode.window.createOutputChannel('Swage');
  controller = new AgentController(context, output);

  context.subscriptions.push(
    output,
    controller,
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const handlers: Partial<Record<(typeof COMMANDS)[number]['id'], () => unknown>> = {
    'swage.openAgent': () => controller?.focus(),
    'swage.stop': () => controller?.stop(),
  };
  for (const spec of COMMANDS) {
    const handler =
      handlers[spec.id] ?? (() => void vscode.window.showInformationMessage(stubMessage(spec)));
    context.subscriptions.push(vscode.commands.registerCommand(spec.id, handler));
  }
  output.appendLine(`Swage activated in ${Math.round(performance.now() - started)} ms`);
}

export async function deactivate(): Promise<void> {
  // TrueForge stops before the MCP server (upstream issue 878).
  await controller?.shutdown();
  controller = undefined;
}
