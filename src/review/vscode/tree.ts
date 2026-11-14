import * as vscode from 'vscode';
import { fileStats } from '../model';
import { statusLetter } from '../../ui/changes';
import type { ReviewSession } from '../session';

/**
 * The Review view (blueprint section 8): a summary, then each changed file with its block count
 * and added and removed lines, then each block with its state. Clicking opens the native diff.
 */

export type ReviewNode =
  | { readonly kind: 'summary' }
  | { readonly kind: 'file'; readonly path: string }
  | {
      readonly kind: 'block';
      readonly path: string;
      readonly blockId: string;
      readonly index: number;
    };

const ICONS = {
  pending: 'circle-large-outline',
  accepted: 'pass-filled',
  rejected: 'circle-slash',
} as const;

export class ReviewTree implements vscode.TreeDataProvider<ReviewNode> {
  private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly current: () => ReviewSession | undefined) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** Blocks belong to their file; files sit at the top (needed for Expand all). */
  getParent(node: ReviewNode): ReviewNode | undefined {
    return node.kind === 'block' ? { kind: 'file', path: node.path } : undefined;
  }

  getChildren(node?: ReviewNode): ReviewNode[] {
    const session = this.current();
    if (!session) return [];
    if (!node)
      return [
        { kind: 'summary' },
        // The same order as the files-changed bar: by path.
        ...session
          .files()
          .map((f) => f.path)
          .sort()
          .map((path): ReviewNode => ({ kind: 'file', path })),
      ];
    if (node.kind === 'file') {
      const settled = ['applied', 'discarded'].includes(session.status(node.path));
      if (settled) return [];
      return (session.file(node.path)?.blocks ?? []).map((b, index): ReviewNode => ({
        kind: 'block',
        path: node.path,
        blockId: b.id,
        index,
      }));
    }
    return [];
  }

  getTreeItem(node: ReviewNode): vscode.TreeItem {
    const session = this.current();
    if (!session) return new vscode.TreeItem('');
    if (node.kind === 'summary') {
      const t = session.totals();
      const open = session.openFiles().length;
      const item = new vscode.TreeItem(
        `${open} file${open === 1 ? '' : 's'} with changes, ${t.blocks} block${t.blocks === 1 ? '' : 's'}`,
      );
      item.description = `${t.accepted} accepted · ${t.rejected} rejected · ${t.pending} pending`;
      item.id = `summary:${session.taskId}`;
      item.iconPath = new vscode.ThemeIcon('checklist');
      item.contextValue = 'swage.review.summary';
      item.tooltip = 'Accept or reject each block, then Apply. Nothing is written until you apply.';
      return item;
    }
    if (node.kind === 'file') {
      const file = session.file(node.path);
      const status = session.status(node.path);
      const settled = status === 'applied' || status === 'discarded';
      const name = node.path.split('/').pop() ?? node.path;
      const dir = node.path.slice(0, Math.max(0, node.path.length - name.length - 1));
      const stats = file ? fileStats(file) : undefined;
      const item = new vscode.TreeItem(
        name,
        settled
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `file:${session.taskId}:${node.path}`;
      // Status letter as in source control, signed counts, the folder, and where the file stands.
      item.description = [
        file ? statusLetter(file.kind) : '',
        stats ? `+${stats.added} -${stats.removed}` : '',
        dir,
        status === 'pending' ? '' : status,
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = `${node.path}\n${status}${settled ? '' : ' · Accept file applies it now; Reject file discards it'}`;
      item.resourceUri = vscode.Uri.file(node.path);
      // An expandable item with a resource gets a folder icon by default; these are files.
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = settled ? 'swage.review.file.settled' : 'swage.review.file';
      item.command = {
        command: 'swage.review.openFile',
        title: 'Open diff',
        arguments: [{ path: node.path }],
      };
      return item;
    }
    const block = session.file(node.path)?.blocks.find((b) => b.id === node.blockId);
    const pos = session.preview(node.path).blocks.find((b) => b.id === node.blockId);
    const item = new vscode.TreeItem(`Block ${node.index + 1}`);
    item.id = `block:${session.taskId}:${node.path}:${node.blockId}`;
    item.description = `${block?.state ?? ''} · line ${(pos?.start ?? 0) + 1} · +${block?.newLines.length ?? 0} -${block?.oldLines.length ?? 0}${block?.whitespaceOnly ? ' · whitespace' : ''}`;
    item.iconPath = new vscode.ThemeIcon(ICONS[block?.state ?? 'pending']);
    item.contextValue = `swage.review.block.${block?.state ?? 'pending'}`;
    item.command = {
      command: 'swage.review.openFile',
      title: 'Show block',
      arguments: [{ path: node.path, blockId: node.blockId }],
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
