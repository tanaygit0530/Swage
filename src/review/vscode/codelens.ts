import * as vscode from 'vscode';
import type { ReviewSession } from '../session';
import { pathOf, STAGED_SCHEME } from './documents';

/**
 * Accept, Reject and Split above every change block in the staged side of the diff (blueprint
 * sections 3 and 8). Decisions stay toggleable until apply: a decided block shows its state and
 * offers the opposite action. Split appears only when a block has more than one line on a side.
 */
export class ReviewCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly current: () => ReviewSession | undefined) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.current();
    if (!session || doc.uri.scheme !== STAGED_SCHEME || doc.uri.query !== session.taskId) return [];
    const path = pathOf(doc.uri);
    const blocks = session.preview(path).blocks;
    const lenses: vscode.CodeLens[] = [];
    const lastLine = Math.max(0, doc.lineCount - 1);
    blocks.forEach((b, i) => {
      const range = new vscode.Range(
        Math.min(b.start, lastLine),
        0,
        Math.min(b.start, lastLine),
        0,
      );
      const ref = { path, blockId: b.id };
      const label = `Block ${i + 1}/${blocks.length} · +${b.added} -${b.removed}`;
      const cmd = (title: string, command: string, tooltip: string): vscode.CodeLens =>
        new vscode.CodeLens(range, { title, command, arguments: [ref], tooltip });
      if (b.state === 'pending') {
        lenses.push(cmd(`${label}  ✓ Accept`, 'swage.review.acceptBlock', 'Accept this block'));
        lenses.push(cmd('✗ Reject', 'swage.review.rejectBlock', 'Reject this block'));
      } else if (b.state === 'accepted') {
        lenses.push(cmd(`${label}  ✓ Accepted`, 'swage.review.acceptBlock', 'Accepted'));
        lenses.push(cmd('Reject instead', 'swage.review.rejectBlock', 'Reject this block'));
      } else {
        lenses.push(cmd(`${label}  ✗ Rejected`, 'swage.review.rejectBlock', 'Rejected'));
        lenses.push(cmd('Accept instead', 'swage.review.acceptBlock', 'Accept this block'));
      }
      if (b.added > 1 || b.removed > 1) {
        lenses.push(
          cmd('⇅ Split', 'swage.review.splitBlock', 'Split this block into line-sized blocks'),
        );
      }
      if (i === 0 && blocks.length > 1) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: 'Accept file',
            command: 'swage.review.acceptFile',
            arguments: [{ path }],
          }),
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: 'Reject file',
            command: 'swage.review.rejectFile',
            arguments: [{ path }],
          }),
        );
      }
    });
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
