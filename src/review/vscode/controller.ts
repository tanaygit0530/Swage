import * as vscode from 'vscode';
import { Applier, type ApplyResult, type UndoResult } from '../../changeset/apply';
import { checkpointFile, loadCheckpoints, saveCheckpoints } from '../checkpoints';
import type { ChangeSet } from '../../changeset/changeSet';
import { ReviewSession } from '../session';
import { ReviewCodeLens } from './codelens';
import { ReviewDecorations } from './decorations';
import { BASE_SCHEME, openDiff, ReviewDocuments, STAGED_SCHEME } from './documents';
import { ReviewTree, type ReviewNode } from './tree';
import { VsCodeWorkspaceFs } from './workspaceFs';
import { DiffViewSettings } from './diffView';
import { blockAtLine, neighbourBlock } from '../marks';
import { pathOf } from './documents';

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

/** How a review was started: agent mode uses the Review view, inline mode stays in the editor. */
export interface ReviewMode {
  readonly mode: 'agent' | 'inline';
  /** Inline only: block ids per file that change lines outside the selection (range lock). */
  readonly outside?: ReadonlyMap<string, readonly string[]>;
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
  private modeValue: ReviewMode = { mode: 'agent' };
  /** Inline diff view (and the review options) while a Swage diff tab is open. */
  readonly diffView: DiffViewSettings;
  /** A change set still being staged: diffs can open before review (read-only, no decisions). */
  private watching: ReviewSession | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the review state changes (start, decisions, apply, discard). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(readonly context: vscode.ExtensionContext) {
    this.documents = new ReviewDocuments(() => this.session ?? this.watching);
    this.diffView = new DiffViewSettings(context);
    this.tree = new ReviewTree(() => this.session);
    this.lenses = new ReviewCodeLens(
      () => this.session,
      () => this.modeValue,
    );
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
      vscode.commands.registerCommand('swage.undoLastChangeSet', (opts?: { force?: boolean }) =>
        this.undo(opts ?? {}),
      ),
      vscode.commands.registerCommand('swage.review.acceptAll', () => this.decideAll('accept')),
      vscode.commands.registerCommand('swage.review.acceptChange', () =>
        this.decideFocused('accept'),
      ),
      vscode.commands.registerCommand('swage.review.rejectChange', () =>
        this.decideFocused('reject'),
      ),
      vscode.commands.registerCommand('swage.review.nextChange', () => this.moveFocus(1)),
      vscode.commands.registerCommand('swage.review.previousChange', () => this.moveFocus(-1)),
      vscode.commands.registerCommand('swage.review.rejectAll', () => this.decideAll('reject')),
    );
  }

  get current(): ReviewSession | undefined {
    return this.session;
  }

  /** The mode of the current review. */
  get mode(): ReviewMode {
    return this.modeValue;
  }

  /**
   * Starts reviewing a change set; `onFinish` is called once, after apply or discard. Agent mode
   * focuses the Review view; inline mode opens the diff in the editor with the block lenses only.
   */
  async start(
    taskId: string,
    changeSet: ChangeSet,
    onFinish?: (outcome: ReviewOutcome) => void,
    mode: ReviewMode = { mode: 'agent' },
  ): Promise<void> {
    this.sessionSub?.dispose();
    this.watching = undefined;
    this.session = new ReviewSession(taskId, changeSet);
    this.onFinish = onFinish;
    this.modeValue = mode;
    this.sessionSub = this.session.onDidChange((paths) => this.changed(paths));
    await vscode.commands.executeCommand('setContext', 'swage.reviewActive', true);
    this.refresh();
    if (mode.mode === 'inline') {
      const first = this.session.files()[0];
      const block = first ? this.session.preview(first.path).blocks[0] : undefined;
      if (first) await this.openFile({ path: first.path, ...(block ? { blockId: block.id } : {}) });
    } else {
      await this.show();
    }
  }

  /**
   * Follows a change set the agent is still staging, so the panel's "Open diff" works before
   * the review starts. Refreshes open diffs of the paths just staged.
   */
  watch(taskId: string, changeSet: ChangeSet, paths: readonly string[] = []): void {
    if (this.session) return;
    if (this.watching?.taskId !== taskId) this.watching = new ReviewSession(taskId, changeSet);
    this.documents.refresh(taskId, paths);
  }

  /** Stops following a staging change set (the run was cancelled or failed). */
  unwatch(taskId: string): void {
    if (this.watching?.taskId === taskId) this.watching = undefined;
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
    this.changeEmitter.fire();
  }

  /** Ends the review and reports the outcome to whoever started it. */
  protected async finish(outcome: ReviewOutcome): Promise<void> {
    const cb = this.onFinish;
    this.onFinish = undefined;
    this.sessionSub?.dispose();
    this.session = undefined;
    this.modeValue = { mode: 'agent' };
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

  /** The staged editor in focus and its file, if it belongs to the current review. */
  private focusedStaged(): { editor: vscode.TextEditor; path: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    if (!editor || !uri || uri.scheme !== STAGED_SCHEME || uri.query !== this.session?.taskId)
      return undefined;
    return { editor, path: pathOf(uri) };
  }

  /**
   * Alt+Enter / Alt+Shift+Enter: decides the change under the cursor (or the next one), then
   * moves the cursor to the next change still pending in the file.
   */
  decideFocused(decision: 'accept' | 'reject'): boolean {
    const focus = this.focusedStaged();
    if (!focus || !this.session) return false;
    const line = focus.editor.selection.active.line;
    const block = blockAtLine(this.session.preview(focus.path).blocks, line);
    if (!block || !this.decide({ path: focus.path, blockId: block.id }, decision)) return false;
    const after = this.session.preview(focus.path).blocks.filter((b) => b.state === 'pending');
    const next = neighbourBlock(after, block.start, 1);
    if (next) this.reveal(focus.editor, next.start);
    return true;
  }

  /** Alt+Down / Alt+Up: the next or previous change in the file, wrapping. */
  moveFocus(direction: 1 | -1): number | undefined {
    const focus = this.focusedStaged();
    if (!focus || !this.session) return undefined;
    const target = neighbourBlock(
      this.session.preview(focus.path).blocks,
      focus.editor.selection.active.line,
      direction,
    );
    if (target) this.reveal(focus.editor, target.start);
    return target?.start;
  }

  private reveal(editor: vscode.TextEditor, line: number): void {
    const at = new vscode.Position(Math.min(line, Math.max(0, editor.document.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(
      new vscode.Range(at, at),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
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

  /**
   * Forgets the in-memory undo history, as a window reload does; the next undo reads the
   * checkpoints back from global storage. Used by the integration test that proves undo works
   * after a reload.
   */
  reloadFromStorage(): void {
    this.applierFor = undefined;
  }

  /** Where this workspace's undo history lives in global storage. */
  checkpointPath(): string | undefined {
    const root = this.root();
    return root ? checkpointFile(this.context.globalStorageUri.fsPath, root.fsPath) : undefined;
  }

  protected createApplier(root: vscode.Uri): Applier {
    const file = checkpointFile(this.context.globalStorageUri.fsPath, root.fsPath);
    return new Applier(new VsCodeWorkspaceFs(root), {
      maxUndo: 2,
      history: loadCheckpoints(file, root.fsPath),
    });
  }

  private persist(): void {
    const root = this.root();
    const file = this.checkpointPath();
    const applier = this.applierFor?.applier;
    if (root && file && applier) saveCheckpoints(file, root.fsPath, applier.history);
  }

  /**
   * Restores the last applied change set from its checkpoint (two levels). If a file changed
   * after the apply, asks before overwriting it; `force` skips the question (tests).
   */
  async undo(options: { force?: boolean } = {}): Promise<UndoResult> {
    const applier = this.applier();
    if (!applier) {
      const r: UndoResult = {
        ok: false,
        error: { code: 'nothing_to_undo', message: 'Open a folder first.' },
      };
      return r;
    }
    let r = await applier.undo({ force: options.force === true });
    if (!r.ok && r.error.code === 'conflict' && options.force === undefined) {
      const choice = await vscode.window.showWarningMessage(
        r.error.message,
        { modal: true },
        'Undo anyway',
      );
      if (choice === 'Undo anyway') r = await applier.undo({ force: true });
    }
    if (r.ok) {
      this.persist();
      const n = r.checkpoint.entries.length;
      void vscode.window.showInformationMessage(
        `Restored ${n} file(s) from before the change set.${applier.canUndo ? ' Undo again to go one further back.' : ''}`,
      );
    } else if (r.error.code === 'nothing_to_undo') {
      void vscode.window.showInformationMessage('Nothing to undo: no applied change set is left.');
    } else if (r.error.code !== 'conflict') {
      void vscode.window.showErrorMessage(r.error.message);
    }
    return r;
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

  /** Persists the undo history after an apply. */
  protected async afterApply(): Promise<void> {
    this.persist();
    return Promise.resolve();
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
    const session = this.session ?? this.watching;
    if (!ref || !session) return;
    const line = ref.blockId
      ? session.preview(ref.path).blocks.find((b) => b.id === ref.blockId)?.start
      : undefined;
    await this.diffView.enter();
    await openDiff(session, ref.path, line);
  }

  dispose(): void {
    void this.diffView.restore();
    this.diffView.dispose();
    this.changeEmitter.dispose();
    this.sessionSub?.dispose();
    for (const d of this.disposables) d.dispose();
    this.documents.dispose();
    this.tree.dispose();
    this.lenses.dispose();
  }
}
