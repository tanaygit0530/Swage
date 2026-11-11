import * as vscode from 'vscode';
import { describeStats, fileStats } from '../model';
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

  getChildren(node?: ReviewNode): ReviewNode[] {
    const session = this.current();
    if (!session) return [];
    if (!node)
      return [
        { kind: 'summary' },
        ...session.files().map((f): ReviewNode => ({ kind: 'file', path: f.path })),
      ];
    if (node.kind === 'file') {
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
      const item = new vscode.TreeItem(
        `${t.files} file${t.files === 1 ? '' : 's'}, ${t.blocks} block${t.blocks === 1 ? '' : 's'}`,
      );
      item.description = `${t.accepted} accepted · ${t.rejected} rejected · ${t.pending} pending`;
      item.iconPath = new vscode.ThemeIcon('checklist');
      item.contextValue = 'swage.review.summary';
      item.tooltip = 'Accept or reject each block, then Apply. Nothing is written until you apply.';
      return item;
    }
    if (node.kind === 'file') {
      const file = session.file(node.path);
      const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${file?.kind === 'create' ? 'new · ' : file?.kind === 'delete' ? 'delete · ' : ''}${file ? describeStats(fileStats(file)) : ''}`;
      item.resourceUri = vscode.Uri.file(node.path);
      item.contextValue = 'swage.review.file';
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
