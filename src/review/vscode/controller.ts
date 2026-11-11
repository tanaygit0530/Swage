import * as vscode from 'vscode';
import { Applier, type ApplyResult } from '../../changeset/apply';
import type { ChangeSet } from '../../changeset/changeSet';
import { ReviewSession } from '../session';
import { ReviewCodeLens } from './codelens';
import { ReviewDecorations } from './decorations';
import { BASE_SCHEME, openDiff, ReviewDocuments, STAGED_SCHEME } from './documents';
import { ReviewTree, type ReviewNode } from './tree';
import { VsCodeWorkspaceFs } from './workspaceFs';

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

export interface ApplyOptions {
  /** Ask before applying when blocks are still pending (default true). Tests pass false. */
  readonly confirmPending?: boolean;
  /** On a conflict, re-stage without asking (tests). */
  readonly restageOnConflict?: boolean;
}

export type ApplyCommandResult =
  | {
      readonly ok: true;
      readonly files: readonly string[];
      readonly accepted: number;
      readonly rejected: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_review' | 'nothing_accepted' | 'cancelled' | 'conflict' | 'write_failed';
      readonly message: string;
      readonly restaged?: readonly string[];
    };

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
  readonly lenses: ReviewCodeLens;
  readonly decorations: ReviewDecorations;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<ReviewNode>;
  private applierFor: { root: string; applier: Applier } | undefined;

  constructor(readonly context: vscode.ExtensionContext) {
    this.documents = new ReviewDocuments(() => this.session);
    this.tree = new ReviewTree(() => this.session);
    this.lenses = new ReviewCodeLens(() => this.session);
    this.decorations = new ReviewDecorations(() => this.session);
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
      vscode.languages.registerCodeLensProvider({ scheme: STAGED_SCHEME }, this.lenses),
      this.decorations,
      vscode.window.onDidChangeVisibleTextEditors((editors) => this.decorations.update(editors)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === STAGED_SCHEME) this.decorations.update();
      }),
      vscode.commands.registerCommand('swage.review.acceptBlock', (arg: unknown) =>
        this.decide(arg, 'accept'),
      ),
      vscode.commands.registerCommand('swage.review.rejectBlock', (arg: unknown) =>
        this.decide(arg, 'reject'),
      ),
      vscode.commands.registerCommand('swage.review.splitBlock', (arg: unknown) => this.split(arg)),
      vscode.commands.registerCommand('swage.review.acceptFile', (arg: unknown) =>
        this.decideFile(arg, 'accept'),
      ),
      vscode.commands.registerCommand('swage.review.rejectFile', (arg: unknown) =>
        this.decideFile(arg, 'reject'),
      ),
      vscode.commands.registerCommand('swage.review.apply', (opts?: ApplyOptions) =>
        this.apply(opts),
      ),
      vscode.commands.registerCommand('swage.review.discard', () => this.discard()),
      vscode.commands.registerCommand('swage.review.acceptAll', () => this.decideAll('accept')),
      vscode.commands.registerCommand('swage.review.rejectAll', () => this.decideAll('reject')),
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
    this.lenses.refresh();
    this.decorations.update();
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

  /** Accepts or rejects one block. Returns false if there is no such block. */
  decide(arg: unknown, decision: 'accept' | 'reject'): boolean {
    const ref = toRef(arg);
    if (!this.session || !ref?.blockId) return false;
    return decision === 'accept'
      ? this.session.accept(ref.path, ref.blockId)
      : this.session.reject(ref.path, ref.blockId);
  }

  /** Splits one block into line-sized blocks; returns the new block ids. */
  split(arg: unknown): string[] {
    const ref = toRef(arg);
    if (!this.session || !ref?.blockId) return [];
    return this.session.split(ref.path, ref.blockId);
  }

  decideFile(arg: unknown, decision: 'accept' | 'reject'): boolean {
    // From the diff editor title the argument is the staged URI; with none, use the active editor.
    const ref = toRef(arg) ?? toRef(vscode.window.activeTextEditor?.document.uri);
    if (!this.session || !ref || !this.session.file(ref.path)) return false;
    if (decision === 'accept') this.session.acceptFile(ref.path);
    else this.session.rejectFile(ref.path);
    return true;
  }

  decideAll(decision: 'accept' | 'reject'): boolean {
    if (!this.session) return false;
    if (decision === 'accept') this.session.acceptAll();
    else this.session.rejectAll();
    return true;
  }

  /** The workspace root the change set belongs to. */
  protected root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /** One Applier per workspace root; its history is the undo stack. */
  protected applier(): Applier | undefined {
    const root = this.root();
    if (!root) return undefined;
    if (this.applierFor?.root !== root.toString()) {
      this.applierFor = { root: root.toString(), applier: this.createApplier(root) };
    }
    return this.applierFor.applier;
  }

  protected createApplier(root: vscode.Uri): Applier {
    return new Applier(new VsCodeWorkspaceFs(root));
  }

  /**
   * Applies the accepted blocks atomically (blueprint section 8): every file's current hash must
   * match the hash it was staged against, then all writes go into one WorkspaceEdit. A conflict
   * applies nothing and offers to re-stage the changed files against their current content.
   */
  async apply(options: ApplyOptions = {}): Promise<ApplyCommandResult> {
    const session = this.session;
    const applier = this.applier();
    if (!session || !applier)
      return { ok: false, reason: 'no_review', message: 'There is no change set to apply.' };
    const result = session.result();
    if (result.changes.length === 0) {
      const message = 'No block is accepted yet. Accept blocks, or Discard the change set.';
      void vscode.window.showInformationMessage(message);
      return { ok: false, reason: 'nothing_accepted', message };
    }
    if (result.pending.length > 0 && options.confirmPending !== false) {
      const choice = await vscode.window.showWarningMessage(
        `Apply ${result.accepted.length} accepted block(s)? ${result.pending.length} pending block(s) will not be applied.`,
        { modal: true },
        'Apply',
      );
      if (choice !== 'Apply')
        return { ok: false, reason: 'cancelled', message: 'Apply cancelled.' };
    }

    const t0 = performance.now();
    const applied: ApplyResult = await applier.apply(session.taskId, result.changes);
    if (!applied.ok) {
      const error = applied.error;
      if (error.code === 'conflict') {
        const choice = options.restageOnConflict
          ? 'Re-stage from current files'
          : await vscode.window.showWarningMessage(
              error.message,
              { modal: true },
              'Re-stage from current files',
            );
        if (choice !== 'Re-stage from current files')
          return { ok: false, reason: 'conflict', message: error.message };
        const fs = new VsCodeWorkspaceFs(this.root() ?? vscode.Uri.file('/'));
        const bases = new Map<string, string | undefined>();
        for (const c of error.conflicts) bases.set(c.path, await fs.read(c.path));
        session.rebase(bases);
        const paths = [...bases.keys()];
        void vscode.window.showInformationMessage(
          `Re-staged ${paths.join(', ')} against the current content. Review the blocks again, then Apply.`,
        );
        return { ok: false, reason: 'conflict', message: error.message, restaged: paths };
      }
      void vscode.window.showErrorMessage(error.message);
      return {
        ok: false,
        reason: error.code === 'write_failed' ? 'write_failed' : 'cancelled',
        message: error.message,
      };
    }

    session.changeSet.markApplied();
    await this.afterApply();
    const files = applied.checkpoint.entries.map((e) => e.path);
    const message = `Applied ${files.length} file(s): ${result.accepted.length} block(s) accepted, ${result.rejected.length + result.pending.length} not applied.`;
    await this.finish({
      applied: true,
      accepted: result.accepted,
      rejected: [...result.rejected, ...result.pending],
      message,
    });
    void vscode.window.showInformationMessage(message, 'Undo').then((choice) => {
      if (choice === 'Undo') void vscode.commands.executeCommand('swage.undoLastChangeSet');
    });
    this.lastApplyMs = Math.round(performance.now() - t0);
    return {
      ok: true,
      files,
      accepted: result.accepted.length,
      rejected: result.rejected.length + result.pending.length,
    };
  }

  /** Time the last apply took, for the performance report. */
  lastApplyMs: number | undefined;

  /** Hook for checkpoint persistence (added with undo). */
  protected async afterApply(): Promise<void> {
    // Overridden by the undo step.
  }

  /** Discards the change set without applying anything. */
  async discard(): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    const r = session.result();
    session.changeSet.discard();
    await this.finish({
      applied: false,
      accepted: [],
      rejected: [...r.accepted, ...r.rejected, ...r.pending],
      message: 'The user discarded the change set.',
    });
    return true;
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
    this.lenses.dispose();
  }
}
