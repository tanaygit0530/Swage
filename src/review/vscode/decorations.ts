import * as vscode from 'vscode';
import type { ReviewSession } from '../session';
import { pathOf, STAGED_SCHEME } from './documents';

/** Gutter and overview-ruler marks for each block's state in the staged side of the diff. */
export class ReviewDecorations implements vscode.Disposable {
  private readonly types = {
    pending: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    accepted: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('testing.iconPassed'),
      overviewRulerColor: new vscode.ThemeColor('testing.iconPassed'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    rejected: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'dashed',
      borderColor: new vscode.ThemeColor('editorError.foreground'),
      opacity: '0.7',
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  };

  constructor(private readonly current: () => ReviewSession | undefined) {}

  /** Re-applies decorations to every visible staged editor. */
  update(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    const session = this.current();
    for (const editor of editors) {
      const uri = editor.document.uri;
      if (uri.scheme !== STAGED_SCHEME) continue;
      const blocks =
        session && uri.query === session.taskId ? session.preview(pathOf(uri)).blocks : [];
      const last = Math.max(0, editor.document.lineCount - 1);
      for (const state of ['pending', 'accepted', 'rejected'] as const) {
        const ranges = blocks
          .filter((b) => b.state === state)
          // A block that shows no lines (an accepted deletion) is marked on the line where it was.
          .map(
            (b) =>
              new vscode.Range(
                Math.min(b.start, last),
                0,
                Math.min(Math.max(b.end - 1, b.start), last),
                0,
              ),
          );
        editor.setDecorations(this.types[state], ranges);
      }
    }
  }

  dispose(): void {
    for (const t of Object.values(this.types)) t.dispose();
  }
}
