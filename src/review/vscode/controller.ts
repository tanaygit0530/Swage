import * as vscode from 'vscode';
import type { ChangeSet } from '../../changeset/changeSet';
import { ReviewSession } from '../session';
import { BASE_SCHEME, openDiff, ReviewDocuments, STAGED_SCHEME } from './documents';
import { ReviewTree, type ReviewNode } from './tree';

/**
 * The review experience in VS Code (blueprint section 8): the Review tree, native diffs of
 * original versus staged, per-block decisions, atomic apply and checkpoint undo.
 */

export const REVIEW_VIEW_ID = 'swage.review';

/** How a review ended, reported back to the agent run. */
export interface ReviewOutcome {
  readonly applied: boolean;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly message: string;
}

/** A file reference from a command argument: a tree node, `{ path, blockId }`, or a staged URI. */
export interface BlockRef {
  readonly path: string;
  readonly blockId?: string;
}

export function toRef(arg: unknown): BlockRef | undefined {
  if (arg instanceof vscode.Uri) return { path: arg.path.replace(/^\//, '') };
  if (arg && typeof arg === 'object') {
    const a = arg as { path?: unknown; blockId?: unknown };
    if (typeof a.path === 'string') {
      return { path: a.path, ...(typeof a.blockId === 'string' ? { blockId: a.blockId } : {}) };
    }
  }
  return undefined;
}

export class ReviewController implements vscode.Disposable {
  private session: ReviewSession | undefined;
  private onFinish: ((outcome: ReviewOutcome) => void) | undefined;
  private sessionSub: { dispose(): void } | undefined;
  readonly documents: ReviewDocuments;
  readonly tree: ReviewTree;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<ReviewNode>;

  constructor(readonly context: vscode.ExtensionContext) {
    this.documents = new ReviewDocuments(() => this.session);
    this.tree = new ReviewTree(() => this.session);
    this.view = vscode.window.createTreeView(REVIEW_VIEW_ID, {
      treeDataProvider: this.tree,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.view,
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, this.documents),
      vscode.workspace.registerTextDocumentContentProvider(STAGED_SCHEME, this.documents),
      vscode.commands.registerCommand('swage.reviewChanges', () => this.show()),
      vscode.commands.registerCommand('swage.review.openFile', (arg: unknown) =>
        this.openFile(arg),
      ),
    );
  }

  get current(): ReviewSession | undefined {
    return this.session;
  }

  /** Starts reviewing a change set; `onFinish` is called once, after apply or discard. */
  async start(
    taskId: string,
    changeSet: ChangeSet,
    onFinish?: (outcome: ReviewOutcome) => void,
  ): Promise<void> {
    this.sessionSub?.dispose();
    this.session = new ReviewSession(taskId, changeSet);
    this.onFinish = onFinish;
    this.sessionSub = this.session.onDidChange((paths) => this.changed(paths));
    await vscode.commands.executeCommand('setContext', 'swage.reviewActive', true);
    this.refresh();
    await this.show();
  }

  protected changed(paths: readonly string[]): void {
    if (!this.session) return;
    this.documents.refresh(this.session.taskId, paths);
    this.refresh();
  }

  protected refresh(): void {
    this.tree.refresh();
    const t = this.session?.totals();
    this.view.message = t ? '' : 'No change set to review. Run the agent first.';
    this.view.badge =
      t && t.pending > 0
        ? { value: t.pending, tooltip: `${t.pending} block(s) to review` }
        : undefined;
  }

  /** Ends the review and reports the outcome to whoever started it. */
  protected async finish(outcome: ReviewOutcome): Promise<void> {
    const cb = this.onFinish;
    this.onFinish = undefined;
    this.sessionSub?.dispose();
    this.session = undefined;
    await vscode.commands.executeCommand('setContext', 'swage.reviewActive', false);
    this.refresh();
    cb?.(outcome);
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${REVIEW_VIEW_ID}.focus`);
    const first = this.session?.files()[0];
    if (first) await this.openFile({ path: first.path });
  }

  async openFile(arg: unknown): Promise<void> {
    const ref = toRef(arg);
    if (!ref || !this.session) return;
    const line = ref.blockId
      ? this.session.preview(ref.path).blocks.find((b) => b.id === ref.blockId)?.start
      : undefined;
    await openDiff(this.session, ref.path, line);
  }

  dispose(): void {
    this.sessionSub?.dispose();
    for (const d of this.disposables) d.dispose();
    this.documents.dispose();
    this.tree.dispose();
  }
}
