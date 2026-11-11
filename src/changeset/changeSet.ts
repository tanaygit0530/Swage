import { applyBlocks, computeBlocks, splitBlock, splitBlockByLine, type Block } from './blocks';
import { detectEol, hashText, matchTextStyle, toCrlf, toLf } from './text';

/**
 * In-memory change set keyed by task id (blueprint sections 6 and 8). Nothing here
 * touches the disk: staging only changes the overlay, and `result()` hands the
 * accepted content to the atomic apply step.
 */

/** Reads the current workspace content of a file; `undefined` means it does not exist. */
export interface FileReader {
  read(path: string): Promise<string | undefined>;
}

export type ChangeSetErrorCode =
  | 'context_not_declared'
  | 'undeclared_file'
  | 'anchor_not_found'
  | 'anchor_ambiguous'
  | 'bad_occurrence'
  | 'suspicious_truncation'
  | 'file_not_found'
  | 'file_exists'
  | 'invalid_input'
  | 'unknown_block'
  | 'invalid_split'
  | 'not_staging';

/** A structured, agent-readable error. `message` says what to do next. */
export interface ChangeSetError {
  readonly code: ChangeSetErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly editIndex?: number;
  readonly matchCount?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ChangeSetError };

export type BlockState = 'pending' | 'accepted' | 'rejected';
export type FileKind = 'create' | 'modify' | 'delete';
export type ChangeSetStatus = 'staging' | 'submitted' | 'applied' | 'discarded' | 'undone';

export interface ContextFile {
  readonly path: string;
  readonly reason: string;
}

export interface DeclareContextInput {
  readonly plan: readonly string[];
  readonly files: readonly ContextFile[];
}

export interface AnchorEdit {
  /** Exact text to find in the current staged content of the file. */
  readonly find: string;
  readonly replace: string;
  /** 1-based match to replace when `find` occurs more than once. */
  readonly occurrence?: number;
}

export type StageInput =
  | { readonly kind: 'edit'; readonly path: string; readonly edits: readonly AnchorEdit[] }
  | { readonly kind: 'write'; readonly path: string; readonly content: string }
  | { readonly kind: 'delete'; readonly path: string };

export interface StageSummary {
  readonly path: string;
  readonly kind: FileKind;
  readonly blockCount: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export interface ReviewBlock extends Block {
  readonly state: BlockState;
}

export interface ReviewFile {
  readonly path: string;
  readonly kind: FileKind;
  readonly blocks: readonly ReviewBlock[];
}

/** One file change for the apply step, built from accepted blocks only. */
export type FileChange =
  | { readonly op: 'create'; readonly path: string; readonly content: string }
  | {
      readonly op: 'modify';
      readonly path: string;
      readonly baseHash: string;
      readonly content: string;
    }
  | { readonly op: 'delete'; readonly path: string; readonly baseHash: string };

export interface ChangeSetResult {
  readonly changes: readonly FileChange[];
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly pending: readonly string[];
}

/** A rewrite smaller than this share of the original is refused as a likely truncation. */
export const TRUNCATION_RATIO = 0.2;

interface StagedFile {
  readonly path: string;
  readonly base: string;
  readonly baseExists: boolean;
  readonly baseHash: string | undefined;
  kind: FileKind;
  staged: string;
  blocks: Block[];
  states: Map<string, BlockState>;
  /** Decision for a change with no blocks, such as creating or deleting an empty file. */
  fileDecision: BlockState;
}

function fail(error: ChangeSetError): { ok: false; error: ChangeSetError } {
  return { ok: false, error };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

function countMatches(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return positions;
    positions.push(at);
    from = at + needle.length;
  }
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class ChangeSet {
  private statusValue: ChangeSetStatus = 'staging';
  private readonly plan: string[] = [];
  private readonly declared = new Map<string, string>();
  private readonly files = new Map<string, StagedFile>();

  constructor(
    readonly taskId: string,
    private readonly reader: FileReader,
  ) {}

  get status(): ChangeSetStatus {
    return this.statusValue;
  }

  get declaredContext(): { plan: readonly string[]; files: readonly ContextFile[] } {
    return {
      plan: [...this.plan],
      files: [...this.declared].map(([path, reason]) => ({ path, reason })),
    };
  }

  /** Records the plan and the files the agent intends to touch, with reasons. Repeat calls add files. */
  declareContext(input: DeclareContextInput): Result<{ files: number }> {
    if (input.files.length === 0) {
      return fail({
        code: 'invalid_input',
        message: 'declare_context needs at least one file with a reason.',
      });
    }
    for (const f of input.files) {
      if (f.path.trim() === '' || f.reason.trim() === '') {
        return fail({
          code: 'invalid_input',
          message: 'Every declared file needs a non-empty path and reason.',
        });
      }
    }
    if (input.plan.length > 0) this.plan.splice(0, this.plan.length, ...input.plan);
    for (const f of input.files) this.declared.set(normalizePath(f.path), f.reason.trim());
    return { ok: true, value: { files: this.declared.size } };
  }

  async stage(input: StageInput): Promise<Result<StageSummary>> {
    if (this.statusValue !== 'staging') {
      return fail({
        code: 'not_staging',
        message: `This change set is ${this.statusValue}; staging is closed.`,
      });
    }
    if (this.declared.size === 0) {
      return fail({
        code: 'context_not_declared',
        message:
          'Call declare_context with your plan and the files you will change before staging.',
      });
    }
    const path = normalizePath(input.path);
    if (!this.declared.has(path)) {
      return fail({
        code: 'undeclared_file',
        path,
        message: `${path} is not in the declared context. Call declare_context with this file and a reason, then stage again.`,
      });
    }

    const file = await this.load(path);
    let next: Result<{ staged: string; kind: FileKind }>;
    switch (input.kind) {
      case 'edit':
        next = this.applyEdits(file, input.edits);
        break;
      case 'write':
        next = this.applyWrite(file, input.content);
        break;
      case 'delete':
        next = file.baseExists
          ? { ok: true, value: { staged: '', kind: 'delete' } }
          : fail({
              code: 'file_not_found',
              path,
              message: `${path} does not exist; nothing to delete.`,
            });
        break;
    }
    if (!next.ok) return next;

    file.staged = next.value.staged;
    file.kind = next.value.kind;
    file.blocks = computeBlocks(file.base, file.staged, path);
    file.states = new Map(file.blocks.map((b) => [b.id, 'pending']));
    file.fileDecision = 'pending';

    if (file.kind === 'modify' && file.blocks.length === 0) {
      this.files.delete(path);
    } else {
      this.files.set(path, file);
    }
    return { ok: true, value: summarize(file) };
  }

  private async load(path: string): Promise<StagedFile> {
    const existing = this.files.get(path);
    if (existing) return existing;
    const content = await this.reader.read(path);
    const baseExists = content !== undefined;
    const base = content ?? '';
    return {
      path,
      base,
      baseExists,
      baseHash: baseExists ? hashText(base) : undefined,
      kind: baseExists ? 'modify' : 'create',
      staged: base,
      blocks: [],
      states: new Map(),
      fileDecision: 'pending',
    };
  }

  private applyEdits(
    file: StagedFile,
    edits: readonly AnchorEdit[],
  ): Result<{ staged: string; kind: FileKind }> {
    const { path } = file;
    const isLive = file.kind !== 'delete' && (file.baseExists || this.files.has(path));
    if (!isLive) {
      return fail({
        code: 'file_not_found',
        path,
        message: `${path} does not exist. Use a full-file write to create it.`,
      });
    }
    if (edits.length === 0) {
      return fail({
        code: 'invalid_input',
        path,
        message: 'Provide at least one find/replace edit.',
      });
    }

    const crlf = detectEol(file.staged) === 'crlf';
    let text = crlf ? toLf(file.staged) : file.staged;

    for (const [editIndex, edit] of edits.entries()) {
      const find = crlf ? toLf(edit.find) : edit.find;
      const replace = crlf ? toLf(edit.replace) : edit.replace;
      if (find.length === 0) {
        return fail({
          code: 'anchor_not_found',
          path,
          editIndex,
          message: `Edit ${editIndex}: the find text is empty. Copy an exact, unique snippet from read_files.`,
        });
      }
      const matches = countMatches(text, find);
      if (matches.length === 0) {
        const fuzzy = squash(text).includes(squash(find));
        return fail({
          code: 'anchor_not_found',
          path,
          editIndex,
          matchCount: 0,
          message: fuzzy
            ? `Edit ${editIndex}: the find text matches ${path} only when whitespace is ignored. Copy it exactly, including indentation, from read_files.`
            : `Edit ${editIndex}: the find text was not found in ${path}. Re-read the file and copy an exact snippet.`,
        });
      }
      let index: number;
      if (edit.occurrence === undefined) {
        if (matches.length > 1) {
          return fail({
            code: 'anchor_ambiguous',
            path,
            editIndex,
            matchCount: matches.length,
            message: `Edit ${editIndex}: the find text occurs ${matches.length} times in ${path}. Add surrounding lines to make it unique, or pass occurrence (1 to ${matches.length}).`,
          });
        }
        index = 0;
      } else {
        index = edit.occurrence - 1;
        if (!Number.isInteger(edit.occurrence) || index < 0 || index >= matches.length) {
          return fail({
            code: 'bad_occurrence',
            path,
            editIndex,
            matchCount: matches.length,
            message: `Edit ${editIndex}: occurrence ${edit.occurrence} is invalid; the find text occurs ${matches.length} time(s) in ${path}.`,
          });
        }
      }
      const at = matches[index] ?? 0;
      text = text.slice(0, at) + replace + text.slice(at + find.length);
    }

    return {
      ok: true,
      value: { staged: crlf ? toCrlf(text) : text, kind: file.baseExists ? 'modify' : 'create' },
    };
  }

  private applyWrite(
    file: StagedFile,
    content: string,
  ): Result<{ staged: string; kind: FileKind }> {
    if (!file.baseExists) return { ok: true, value: { staged: content, kind: 'create' } };
    const staged = matchTextStyle(file.base, content);
    if (file.base.length > 0 && staged.length < file.base.length * TRUNCATION_RATIO) {
      const pct = Math.round((staged.length / file.base.length) * 100);
      return fail({
        code: 'suspicious_truncation',
        path: file.path,
        message: `The new content of ${file.path} is ${pct}% of the original size, which looks truncated. Send the complete file, or use find/replace edits for a partial change.`,
      });
    }
    return { ok: true, value: { staged, kind: 'modify' } };
  }

  /** Files and blocks with their review state, in staging order. */
  review(): ReviewFile[] {
    return [...this.files.values()].map((f) => ({
      path: f.path,
      kind: f.kind,
      blocks: f.blocks.map((b) => ({ ...b, state: f.states.get(b.id) ?? 'pending' })),
    }));
  }

  accept(path: string, blockId: string): Result<void> {
    return this.setState(path, blockId, 'accepted');
  }

  reject(path: string, blockId: string): Result<void> {
    return this.setState(path, blockId, 'rejected');
  }

  acceptAll(path?: string): Result<void> {
    return this.setAll('accepted', path);
  }

  rejectAll(path?: string): Result<void> {
    return this.setAll('rejected', path);
  }

  /**
   * Splits a block. With offsets it splits in two; without, it splits into line-sized parts.
   * The parts inherit the block's state.
   */
  split(path: string, blockId: string, oldOffset?: number, newOffset?: number): Result<string[]> {
    const found = this.findBlock(path, blockId);
    if (!found.ok) return found;
    const { file, index, block } = found.value;
    let parts: Block[];
    try {
      parts =
        oldOffset === undefined || newOffset === undefined
          ? splitBlockByLine(block)
          : splitBlock(block, oldOffset, newOffset);
    } catch (err) {
      return fail({ code: 'invalid_split', path: file.path, message: (err as Error).message });
    }
    const state = file.states.get(block.id) ?? 'pending';
    file.blocks.splice(index, 1, ...parts);
    file.states.delete(block.id);
    for (const p of parts) file.states.set(p.id, state);
    return { ok: true, value: parts.map((p) => p.id) };
  }

  private findBlock(
    path: string,
    blockId: string,
  ): Result<{ file: StagedFile; index: number; block: Block }> {
    const p = normalizePath(path);
    const file = this.files.get(p);
    const index = file ? file.blocks.findIndex((b) => b.id === blockId) : -1;
    const block = file?.blocks[index];
    if (!file || !block) {
      return fail({ code: 'unknown_block', path: p, message: `No block ${blockId} in ${p}.` });
    }
    return { ok: true, value: { file, index, block } };
  }

  private setState(path: string, blockId: string, state: BlockState): Result<void> {
    const found = this.findBlock(path, blockId);
    if (!found.ok) return found;
    found.value.file.states.set(blockId, state);
    return { ok: true, value: undefined };
  }

  private setAll(state: BlockState, path?: string): Result<void> {
    const targets = path === undefined ? [...this.files.values()] : [];
    if (path !== undefined) {
      const file = this.files.get(normalizePath(path));
      if (!file) {
        return fail({
          code: 'file_not_found',
          path: normalizePath(path),
          message: `${normalizePath(path)} has no staged changes.`,
        });
      }
      targets.push(file);
    }
    for (const file of targets) {
      file.fileDecision = state;
      for (const b of file.blocks) file.states.set(b.id, state);
    }
    return { ok: true, value: undefined };
  }

  /** The changes built from accepted blocks only, plus block ids by decision. */
  result(): ChangeSetResult {
    const changes: FileChange[] = [];
    const accepted: string[] = [];
    const rejected: string[] = [];
    const pending: string[] = [];

    for (const file of this.files.values()) {
      const ids = file.blocks.filter((b) => file.states.get(b.id) === 'accepted').map((b) => b.id);
      for (const b of file.blocks) {
        const s = file.states.get(b.id) ?? 'pending';
        (s === 'accepted' ? accepted : s === 'rejected' ? rejected : pending).push(b.id);
      }
      const all =
        file.blocks.length === 0
          ? file.fileDecision === 'accepted'
          : ids.length === file.blocks.length;
      if (ids.length === 0 && !all) continue;

      const content = applyBlocks(file.base, file.blocks, ids);
      if (file.kind === 'create') {
        changes.push({ op: 'create', path: file.path, content });
      } else if (file.kind === 'delete' && all) {
        changes.push({ op: 'delete', path: file.path, baseHash: file.baseHash ?? '' });
      } else {
        changes.push({ op: 'modify', path: file.path, baseHash: file.baseHash ?? '', content });
      }
    }
    return { changes, accepted, rejected, pending };
  }

  submit(): void {
    if (this.statusValue === 'staging') this.statusValue = 'submitted';
  }

  markApplied(): void {
    this.statusValue = 'applied';
  }

  markUndone(): void {
    this.statusValue = 'undone';
  }

  discard(): void {
    this.statusValue = 'discarded';
    this.files.clear();
  }
}

function summarize(file: StagedFile): StageSummary {
  let added = 0;
  let removed = 0;
  for (const b of file.blocks) {
    added += b.newLines.length;
    removed += b.oldLines.length;
  }
  return {
    path: file.path,
    kind: file.kind,
    blockCount: file.blocks.length,
    linesAdded: added,
    linesRemoved: removed,
  };
}

/** Holds one change set per task id. */
export class ChangeSetStore {
  private readonly sets = new Map<string, ChangeSet>();

  constructor(private readonly reader: FileReader) {}

  get(taskId: string): ChangeSet {
    let set = this.sets.get(taskId);
    if (!set) {
      set = new ChangeSet(taskId, this.reader);
      this.sets.set(taskId, set);
    }
    return set;
  }

  has(taskId: string): boolean {
    return this.sets.has(taskId);
  }

  discard(taskId: string): void {
    this.sets.get(taskId)?.discard();
    this.sets.delete(taskId);
  }
}
