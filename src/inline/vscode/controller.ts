import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentController } from '../../agent/controller';
import { RUNNING_CONTEXT_KEY } from '../../commands';
import type { ReviewController, ReviewOutcome } from '../../review/vscode/controller';
import { editRange, type LineRange } from '../context';
import { InlineEdit, type InlineOutcome } from '../run';

/**
 * swage.inlineEdit (blueprint sections 3 and 8): instruction box for the selection (or the
 * function around the cursor), a spinner and live status in the status bar, Escape to cancel
 * through the agent-mode path, and the result as block review in the editor.
 */

export interface InlineEditArgs {
  /** Skips the input box (tests and keybinding arguments). */
  readonly instruction?: string;
}

export type InlineCommandResult =
  InlineOutcome | { readonly kind: 'refused'; readonly message: string };

export class InlineController implements vscode.Disposable {
  private edit: InlineEdit | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly highlight: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last outcome, for tests and the performance report. */
  last: InlineCommandResult | undefined;
  /** Milliseconds from submitting the instruction to the diff opening (Task A target: 15 s). */
  lastDiffMs: number | undefined;

  constructor(
    private readonly agent: AgentController,
    private readonly review: ReviewController,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.status.name = 'Swage inline edit';
    this.status.command = 'swage.stop';
    this.highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      border: '1px dashed',
      borderColor: new vscode.ThemeColor('focusBorder'),
    });
    this.disposables.push(
      this.status,
      this.highlight,
      vscode.commands.registerCommand('swage.inlineEdit', (args?: InlineEditArgs) =>
        this.run(args ?? {}),
      ),
    );
  }

  /** True while the inline agent is starting or streaming. */
  get running(): boolean {
    const s = this.edit?.run.state;
    return s === 'starting' || s === 'running';
  }

  private refuse(message: string): InlineCommandResult {
    void vscode.window.showInformationMessage(message);
    this.last = { kind: 'refused', message };
    return this.last;
  }

  async run(args: InlineEditArgs): Promise<InlineCommandResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return this.refuse('Open a file and select the code to edit first.');
    // One TrueForge turn at a time, and one change set under review (blueprint section 8).
    if (this.running || this.agent.busy)
      return this.refuse('Swage is already running. Stop it first (Escape).');
    if (this.review.current)
      return this.refuse('Finish the open review first: Apply or Discard the current change set.');
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder || editor.document.uri.scheme !== 'file')
      return this.refuse('Inline edit works on files inside the open workspace folder.');
    const rel = path
      .relative(folder.uri.fsPath, editor.document.uri.fsPath)
      .split(path.sep)
      .join('/');

    // Start the runtime while the user types; it is shared with agent mode.
    const runtime = this.agent.runtimeReady();
    runtime.catch(() => undefined);
    const sel = editor.selection;
    const symbolsNow = this.agent.readyRuntime?.index.get(rel)?.symbols;
    let range = editRange(symbolsNow ?? [], {
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      endCharacter: sel.end.character,
      empty: sel.isEmpty,
    });
    this.mark(editor, range);

    let instruction = args.instruction;
    if (instruction === undefined) {
      instruction = await vscode.window.showInputBox({
        title: `Swage: edit ${rel} lines ${range.startLine}-${range.endLine}`,
        prompt: 'Describe the change. Only the highlighted lines may change.',
        placeHolder: 'For example: treat "off" as false too, and update the docstring',
        ignoreFocusOut: true,
      });
    }
    if (!instruction?.trim()) {
      editor.setDecorations(this.highlight, []);
      this.last = { kind: 'refused', message: 'No instruction.' };
      return this.last;
    }

    const t0 = performance.now();
    this.show('Starting TrueForge and the editor tools…');
    await vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, true);
    try {
      let rt;
      try {
        rt = await runtime;
      } catch (err) {
        return this.end({ kind: 'error', message: (err as Error).message.split('\n')[0] ?? '' });
      }
      // With no selection the function around the cursor is the target; the index knows it now.
      if (sel.isEmpty && !symbolsNow) {
        range = editRange(rt.index.get(rel)?.symbols ?? [], {
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          endCharacter: sel.end.character,
          empty: true,
        });
        this.mark(editor, range);
      }
      this.edit = new InlineEdit({
        client: rt.client,
        ctx: rt.ctx,
        relay: rt.relay,
        approvals: rt.approvals,
        agentName: rt.inlineAgentName,
        logger: this.agent.log,
        request: {
          instruction,
          path: rel,
          text: editor.document.getText(),
          range,
          symbols: rt.index.get(rel)?.symbols ?? [],
          language: editor.document.languageId,
        },
        onStatus: (text) => this.show(text),
        resilience: this.agent.resilience(rt, 'swage-inline'),
      });
      const outcome = await this.edit.start();
      if (outcome.kind === 'review') {
        await this.review.start(
          outcome.taskId,
          outcome.changeSet,
          (r) => this.reviewed(outcome.taskId, r),
          { mode: 'inline', outside: outcome.outside },
        );
        this.lastDiffMs = Math.round(performance.now() - t0);
        this.agent.log.info(`inline edit: diff shown ${this.lastDiffMs} ms after the instruction`);
      }
      return this.end(outcome);
    } finally {
      editor.setDecorations(this.highlight, []);
      await vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, this.agent.busy);
    }
  }

  private mark(editor: vscode.TextEditor, range: LineRange): void {
    editor.setDecorations(this.highlight, [
      new vscode.Range(range.startLine - 1, 0, range.endLine - 1, 0),
    ]);
  }

  private end(outcome: InlineOutcome): InlineCommandResult {
    this.last = outcome;
    this.status.hide();
    switch (outcome.kind) {
      case 'review':
        vscode.window.setStatusBarMessage(`$(check) Swage: ${outcome.message}`, 5000);
        break;
      case 'cancelled':
        void vscode.window.showInformationMessage(outcome.message);
        break;
      case 'nothing':
        void vscode.window.showInformationMessage(outcome.message);
        break;
      case 'error':
        void vscode.window.showErrorMessage(`Swage inline edit: ${outcome.message}`);
        break;
    }
    return outcome;
  }

  private reviewed(taskId: string, outcome: ReviewOutcome): void {
    void this.agent
      .runtimeReady()
      .then((rt) => (outcome.applied ? rt.ctx.tasks.finish(taskId) : rt.ctx.tasks.cancel(taskId)))
      .catch(() => undefined);
  }

  private show(text: string): void {
    this.status.text = `$(loading~spin) Swage: ${text}`;
    this.status.tooltip = 'Inline edit running. Press Escape or click to cancel.';
    this.status.show();
  }

  /** Escape: cancels the inline run through the same path as agent mode. */
  async stop(): Promise<boolean> {
    if (!this.running || !this.edit) return false;
    await this.edit.cancel();
    return true;
  }

  dispose(): void {
    void this.stop();
    for (const d of this.disposables) d.dispose();
  }
}
