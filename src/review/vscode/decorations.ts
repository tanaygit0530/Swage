import * as vscode from 'vscode';
import { blockMarks, type BlockMark } from '../marks';
import type { ReviewSession } from '../session';
import { pathOf, STAGED_SCHEME } from './documents';

/**
 * Swage's marks on the staged side of a diff (review upgrade, steps 1 and 2). The diff editor
 * itself draws removed lines red and added lines green with word-level highlights and +/-
 * indicators; Swage adds overview-ruler and minimap ticks (green for additions, red where lines
 * were removed) so changes are easy to find in a long file, dims unchanged context, and greys
 * decided blocks: accepted with a tick, rejected with a cross and "original kept" (never struck
 * through: those lines stay). A decided block with no lines gets only a note on the line above.
 * Colours are theme tokens.
 * Minimap marks are not in VS Code's public decoration API, so Swage's ticks are on the overview
 * ruler; the diff editor's own minimap still shows its diff colours.
 */

const type = (o: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType =>
  vscode.window.createTextEditorDecorationType(o);

export class ReviewDecorations implements vscode.Disposable {
  private readonly types: Record<BlockMark['kind'], vscode.TextEditorDecorationType> = {
    added: type({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    removed: type({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        color: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        margin: '0 0 0 1.5em',
      },
    }),
    context: type({ opacity: '0.62' }),
    accepted: type({
      isWholeLine: true,
      opacity: '0.55',
      overviewRulerColor: new vscode.ThemeColor('descriptionForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        color: new vscode.ThemeColor('testing.iconPassed'),
        margin: '0 0 0 1.5em',
      },
    }),
    rejected: type({
      isWholeLine: true,
      opacity: '0.55',
      overviewRulerColor: new vscode.ThemeColor('descriptionForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        color: new vscode.ThemeColor('descriptionForeground'),
        margin: '0 0 0 1.5em',
      },
    }),
    note: type({
      overviewRulerColor: new vscode.ThemeColor('descriptionForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      after: {
        color: new vscode.ThemeColor('descriptionForeground'),
        margin: '0 0 0 1.5em',
      },
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
      const marks = blockMarks(blocks, editor.document.lineCount);
      for (const kind of Object.keys(this.types) as BlockMark['kind'][]) {
        const options: vscode.DecorationOptions[] = marks
          .filter((m) => m.kind === kind)
          .map((m) => ({
            range: new vscode.Range(m.start, 0, m.end, 0),
            ...(m.note ? { renderOptions: { after: { contentText: `  ${m.note}` } } } : {}),
          }));
        editor.setDecorations(this.types[kind], options);
      }
    }
  }

  dispose(): void {
    for (const t of Object.values(this.types)) t.dispose();
  }
}
