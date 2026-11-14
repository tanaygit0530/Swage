import * as vscode from 'vscode';
import { STAGED_SCHEME } from './documents';

/**
 * How Swage's diff tabs look (review upgrade, steps 0, 1 and 7). VS Code has no per-tab option
 * for the inline diff: `vscode.diff` takes no view mode, and the toggle command flips the user's
 * `diffEditor.renderSideBySide` setting for every diff. So Swage sets the diff settings it needs
 * (inline view, and optionally hidden whitespace and collapsed unchanged regions) only while a
 * Swage diff tab is open, at the level where the user's own value lives, and puts back exactly
 * what was there when the last Swage diff tab closes. The original values are kept in global
 * state; if VS Code quits or reloads with a Swage diff open, the next start restores them (a
 * settings write during shutdown can be lost, so none is attempted then). A value the user
 * changes while a Swage diff is open is left alone.
 */

const STATE_KEY = 'swage.diffView.saved';
const RESTORE_DELAY_MS = 1000;

interface Saved {
  readonly key: string;
  readonly target: vscode.ConfigurationTarget;
  /** The user's value before Swage changed it (undefined: not set at that level). */
  readonly previous: unknown;
  /** What Swage wrote, so a later change by the user is recognised and kept. */
  readonly applied: unknown;
}

/** Splits `diffEditor.renderSideBySide` into the section and the key VS Code's API wants. */
function split(full: string): { section: string; key: string } {
  const i = full.indexOf('.');
  return { section: full.slice(0, i), key: full.slice(i + 1) };
}

/** The level a setting's effective value comes from (Swage writes there so it takes effect). */
export function targetOf(inspect: {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
}): vscode.ConfigurationTarget {
  if (inspect.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspect.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function valueAt(
  inspect: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown },
  target: vscode.ConfigurationTarget,
): unknown {
  return target === vscode.ConfigurationTarget.WorkspaceFolder
    ? inspect.workspaceFolderValue
    : target === vscode.ConfigurationTarget.Workspace
      ? inspect.workspaceValue
      : inspect.globalValue;
}

/** True when a tab shows a Swage diff (its modified side is a staged preview). */
export function isSwageDiffTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return input instanceof vscode.TabInputTextDiff && input.modified.scheme === STAGED_SCHEME;
}

export class DiffViewSettings implements vscode.Disposable {
  private saved: Saved[];
  private readonly sub: vscode.Disposable;
  private busy: Promise<void> = Promise.resolve();
  /**
   * The user's own value of each setting, captured the first time Swage changes it in this
   * window and reused after: right after a restore a read can still show Swage's value, which
   * must never be recorded as the user's.
   */
  private readonly baseline = new Map<
    string,
    { target: vscode.ConfigurationTarget; previous: unknown }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Restores a moment after the last Swage diff closes: opening the next file closes one tab and
   * opens another, and VS Code's configuration reads can lag a write by a moment.
   */
  private scheduleRestore(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.anySwageDiff()) void this.restore();
    }, RESTORE_DELAY_MS);
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.saved = context.globalState.get<Saved[]>(STATE_KEY, []);
    this.sub = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (this.saved.length > 0 && !this.anySwageDiff()) this.scheduleRestore();
    });
    // Left over from a crash or a reload while a Swage diff was open.
    if (this.saved.length > 0 && !this.anySwageDiff()) void this.restore();
  }

  /** What Swage changed and will put back (tests and diagnostics). */
  get pending(): readonly { key: string; previous: unknown; applied: unknown }[] {
    return this.saved;
  }

  /** The settings Swage's diff tabs want, from swage.review.* and the review options. */
  wanted(): Record<string, unknown> {
    const review = vscode.workspace.getConfiguration('swage.review');
    const out: Record<string, unknown> = {};
    if (review.get<boolean>('inlineDiff', true)) out['diffEditor.renderSideBySide'] = false;
    // A review shows every change, whitespace included (VS Code hides trim whitespace by
    // default); "Hide whitespace changes" turns that back on for Swage's diffs.
    out['diffEditor.ignoreTrimWhitespace'] = this.context.workspaceState.get<boolean>(
      'swage.review.hideWhitespace',
      false,
    );
    if (this.context.workspaceState.get<boolean>('swage.review.collapseUnchanged', false))
      out['diffEditor.hideUnchangedRegions.enabled'] = true;
    return out;
  }

  private anySwageDiff(): boolean {
    return vscode.window.tabGroups.all.some((g) => g.tabs.some(isSwageDiffTab));
  }

  /** Applies the wanted diff settings before a Swage diff opens. */
  enter(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.busy = this.busy.then(() => this.doEnter()).catch(() => undefined);
    return this.busy;
  }

  private async doEnter(): Promise<void> {
    const wanted = this.wanted();
    // A setting Swage no longer wants (an option turned off) goes back first.
    for (const s of this.saved.filter((x) => !(x.key in wanted))) await this.restoreOne(s);
    this.saved = this.saved.filter((x) => x.key in wanted);
    for (const [full, value] of Object.entries(wanted)) {
      const { section, key } = split(full);
      const config = vscode.workspace.getConfiguration(section);
      // Already as wanted and recorded: nothing to do. (Without a record, write anyway: the read
      // may be stale right after a restore.)
      if (config.get(key) === value && this.saved.some((s) => s.key === full)) continue;
      if (config.get(key) === value && !this.baseline.has(full)) continue;
      const inspect = config.inspect(key) ?? {};
      const known = this.baseline.get(full);
      const target = known?.target ?? targetOf(inspect);
      const previous = known ? known.previous : valueAt(inspect, target);
      if (!known) this.baseline.set(full, { target, previous });
      if (!this.saved.some((s) => s.key === full))
        this.saved.push({ key: full, target, previous, applied: value });
      // The original value is recorded before the setting changes, so a crash in between can
      // never leave an override Swage does not know how to undo.
      await this.context.globalState.update(STATE_KEY, this.saved);
      await config.update(key, value, target);
    }
  }

  /** Puts the user's own values back (when the last Swage diff closes, and on shutdown). */
  restore(): Promise<void> {
    this.busy = this.busy
      .then(async () => {
        for (const s of this.saved) await this.restoreOne(s);
        this.saved = [];
        await this.context.globalState.update(STATE_KEY, []);
      })
      .catch(() => undefined);
    return this.busy;
  }

  private async restoreOne(s: Saved): Promise<void> {
    const { section, key } = split(s.key);
    const config = vscode.workspace.getConfiguration(section);
    // The user set something else while the diff was open: theirs wins. (A read that still shows
    // the old value right after Swage's write is not a user change.)
    const now = valueAt(config.inspect(key) ?? {}, s.target);
    if (now !== s.applied && now !== s.previous) return;
    await config.update(key, s.previous, s.target);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.sub.dispose();
  }
}
