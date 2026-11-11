import * as vscode from 'vscode';
import type { SdkLike } from './client/client';
import { AGENT_VIEW_ID, AgentController } from './agent/controller';
import { COMMANDS, RUNNING_CONTEXT_KEY, stubMessage } from './commands';
import { ReviewController } from './review/vscode/controller';

let controller: AgentController | undefined;
let review: ReviewController | undefined;

/** Returned by activate() only when SWAGE_TEST_API=1 (set by the integration test config). */
export interface SwageTestApi {
  setSdkFactory(factory: (mcp: { url: string; token: string }) => SdkLike): void;
  startRun(prompt: string): Promise<void>;
  runState(): string | undefined;
  readonly review: ReviewController;
}

export function activate(context: vscode.ExtensionContext): SwageTestApi | undefined {
  const started = performance.now();
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);
  const output = vscode.window.createOutputChannel('Swage');
  review = new ReviewController(context);
  controller = new AgentController(context, output, review);

  context.subscriptions.push(
    output,
    review,
    controller,
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // swage.reviewChanges and swage.undoLastChangeSet are registered by the ReviewController.
  const handlers: Partial<Record<(typeof COMMANDS)[number]['id'], () => unknown>> = {
    'swage.openAgent': () => controller?.focus(),
    'swage.stop': () => controller?.stop(),
  };
  const ownedElsewhere = new Set<string>(['swage.reviewChanges', 'swage.undoLastChangeSet']);
  for (const spec of COMMANDS) {
    if (ownedElsewhere.has(spec.id)) continue;
    const handler =
      handlers[spec.id] ?? (() => void vscode.window.showInformationMessage(stubMessage(spec)));
    context.subscriptions.push(vscode.commands.registerCommand(spec.id, handler));
  }
  output.appendLine(`Swage activated in ${Math.round(performance.now() - started)} ms`);

  if (process.env['SWAGE_TEST_API'] !== '1') return undefined;
  const agent = controller;
  const reviewer = review;
  return {
    setSdkFactory: (factory) => {
      agent.sdkFactory = factory;
    },
    startRun: (prompt) => agent.start(prompt),
    runState: () => agent.runState,
    review: reviewer,
  };
}

export async function deactivate(): Promise<void> {
  // TrueForge stops before the MCP server (upstream issue 878).
  await controller?.shutdown();
  controller = undefined;
}
