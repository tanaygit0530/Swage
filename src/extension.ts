import * as vscode from 'vscode';
import { COMMANDS, RUNNING_CONTEXT_KEY, stubMessage } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, false);

  for (const spec of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(spec.id, () => {
        void vscode.window.showInformationMessage(stubMessage(spec));
      }),
    );
  }
}

export function deactivate(): void {
  // Nothing to clean up yet. The TrueForge supervisor will stop its child process here.
}
