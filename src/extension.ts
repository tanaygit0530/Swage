import * as vscode from 'vscode';
import { AGENT_VIEW_ID, AgentController } from './agent/controller';
import { COMMANDS, RUNNING_CONTEXT_KEY, stubMessage } from './commands';
import { ReviewController } from './review/vscode/controller';

let controller: AgentController | undefined;
let review: ReviewController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const started = performance.now();
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);
  const output = vscode.window.createOutputChannel('Swage');
  review = new ReviewController(context);
  controller = new AgentController(context, output);

  context.subscriptions.push(
    output,
    review,
    controller,
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // swage.reviewChanges is registered by the ReviewController.
  const handlers: Partial<Record<(typeof COMMANDS)[number]['id'], () => unknown>> = {
    'swage.openAgent': () => controller?.focus(),
    'swage.stop': () => controller?.stop(),
  };
  const ownedElsewhere = new Set<string>(['swage.reviewChanges']);
  for (const spec of COMMANDS) {
    if (ownedElsewhere.has(spec.id)) continue;
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
