import * as vscode from 'vscode';
import type { ReviewSession } from '../session';

/**
 * Read-only virtual documents for the native diff editor (blueprint section 8): `swage-base:`
 * holds the original content the change set was staged against, `swage-staged:` the live
 * preview (every block that is not rejected). The query carries the task id, so documents from
 * an older change set are never confused with the current one.
 */

export const BASE_SCHEME = 'swage-base';
export const STAGED_SCHEME = 'swage-staged';

export function reviewUri(
  scheme: typeof BASE_SCHEME | typeof STAGED_SCHEME,
  taskId: string,
  path: string,
): vscode.Uri {
  return vscode.Uri.from({ scheme, path: `/${path}`, query: taskId });
}

export function pathOf(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

export class ReviewDocuments implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly current: () => ReviewSession | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.current();
    if (!session || uri.query !== session.taskId) return '';
    const path = pathOf(uri);
    return uri.scheme === BASE_SCHEME ? session.base(path) : session.preview(path).content;
  }

  /** Tells VS Code the staged preview of these paths changed. */
  refresh(taskId: string, paths: readonly string[]): void {
    for (const p of paths) this.emitter.fire(reviewUri(STAGED_SCHEME, taskId, p));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Opens the native diff of original versus staged for one file, optionally at a line. */
export async function openDiff(
  session: ReviewSession,
  path: string,
  line?: number,
): Promise<vscode.TextEditor | undefined> {
  const left = reviewUri(BASE_SCHEME, session.taskId, path);
  const right = reviewUri(STAGED_SCHEME, session.taskId, path);
  const file = session.file(path);
  const label =
    file?.kind === 'create' ? 'new file' : file?.kind === 'delete' ? 'deleted' : 'staged';
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${path} (original ↔ ${label})`,
    {
      preview: false,
      ...(line === undefined ? {} : { selection: new vscode.Range(line, 0, line, 0) }),
    },
  );
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === right.toString(),
  );
}
