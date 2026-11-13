import * as vscode from 'vscode';
import type { SdkLike } from './client/client';
import { AGENT_VIEW_ID, AgentController, type RunEventRecord } from './agent/controller';
import { COMMANDS, RUNNING_CONTEXT_KEY, stubMessage } from './commands';
import { DoctorController } from './doctor/vscode';
import { InlineController } from './inline/vscode/controller';
import { ModelsController } from './resilience/vscode/models';
import { ReviewController } from './review/vscode/controller';

let controller: AgentController | undefined;
let review: ReviewController | undefined;
let inline: InlineController | undefined;
let models: ModelsController | undefined;
let doctor: DoctorController | undefined;

/** Returned by activate() only when SWAGE_TEST_API=1 (set by the integration test config). */
export interface SwageTestApi {
  setSdkFactory(factory: (mcp: { url: string; token: string }) => SdkLike): void;
  startRun(prompt: string): Promise<void>;
  runState(): string | undefined;
  runTaskId(): string | undefined;
  decidePending(allow: boolean, reason?: string): Promise<string[]>;
  resetRuntime(): Promise<void>;
  onRunEvent(listener: (e: RunEventRecord) => void): vscode.Disposable;
  readonly review: ReviewController;
  readonly inline: InlineController;
  readonly models: ModelsController;
  readonly doctor: DoctorController;
}

export function activate(context: vscode.ExtensionContext): SwageTestApi | undefined {
  const started = performance.now();
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);
  const output = vscode.window.createOutputChannel('Swage');
  review = new ReviewController(context);
  models = new ModelsController(context);
  controller = new AgentController(context, output, review, models);
  inline = new InlineController(controller, review);
  doctor = new DoctorController(context, controller, models, output);

  context.subscriptions.push(
    output,
    models,
    review,
    controller,
    inline,
    doctor,
    vscode.window.registerWebviewViewProvider(AGENT_VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // swage.reviewChanges and swage.undoLastChangeSet belong to the ReviewController,
  // swage.inlineEdit to the InlineController, swage.switchModel to the ModelsController, swage.doctor to the DoctorController.
  const handlers: Partial<Record<(typeof COMMANDS)[number]['id'], () => unknown>> = {
    'swage.openAgent': () => controller?.focus(),
    'swage.focusComposer': () => controller?.focusComposer(),
    // Escape stops whichever run is active: the inline edit first, then the agent run.
    'swage.stop': async () => {
      if (!(await inline?.stop())) await controller?.stop();
    },
  };
  const ownedElsewhere = new Set<string>([
    'swage.reviewChanges',
    'swage.undoLastChangeSet',
    'swage.inlineEdit',
    'swage.switchModel',
    'swage.doctor',
  ]);
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
  const inliner = inline;
  const modeller = models;
  const doc = doctor;
  return {
    setSdkFactory: (factory) => {
      agent.sdkFactory = factory;
    },
    startRun: (prompt) => agent.start(prompt),
    runState: () => agent.runState,
    runTaskId: () => agent.runTaskId,
    decidePending: (allow, reason) => agent.decidePending(allow, reason),
    resetRuntime: () => agent.resetRuntime(),
    onRunEvent: (listener) => agent.onRunEvent(listener),
    review: reviewer,
    inline: inliner,
    models: modeller,
    doctor: doc,
  };
}

export async function deactivate(): Promise<void> {
  // TrueForge stops before the MCP server (upstream issue 878).
  await controller?.shutdown();
  controller = undefined;
}
