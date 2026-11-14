import * as vscode from 'vscode';
import { CommentQueue, type ReviewComment } from '../comments';
import { pathOf, STAGED_SCHEME } from './documents';

/**
 * Comments on code in Swage's diffs (review upgrade, step 6), with VS Code's Comments API. The
 * staged side of every Swage diff is commentable, so the gutter shows "+"; Cmd+Alt+M (Ctrl+Alt+M)
 * opens a comment box on the selection. Saved comments show as threads under those lines, as a
 * chip above the composer, and go to the agent with the next request (then they are cleared).
 */

export const COMMENT_CONTROLLER_ID = 'swage.review';

class SwageComment implements vscode.Comment {
  readonly mode = vscode.CommentMode.Preview;
  readonly author = { name: 'You' };
  readonly contextValue = 'swage.review.comment';
  constructor(
    readonly body: string,
    readonly id: string,
    readonly thread: vscode.CommentThread,
  ) {}
}

export class ReviewComments implements vscode.Disposable {
  readonly queue = new CommentQueue();
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController(
      COMMENT_CONTROLLER_ID,
      'Swage review comments',
    );
    this.controller.options = {
      prompt: 'Comment for the agent (sent with your next request)',
      placeHolder: 'What should change here?',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        doc.uri.scheme === STAGED_SCHEME
          ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)]
          : [],
    };
    this.disposables.push(
      this.controller,
      vscode.commands.registerCommand('swage.review.addComment', () => this.open()),
      vscode.commands.registerCommand('swage.review.saveComment', (reply: vscode.CommentReply) =>
        this.save(reply),
      ),
      vscode.commands.registerCommand('swage.review.deleteComment', (c: SwageComment) =>
        this.remove(c.id),
      ),
      vscode.commands.registerCommand('swage.review.clearComments', () => this.clear()),
    );
  }

  /** Cmd+Alt+M: a comment box on the selected lines of the staged side. */
  open(): vscode.CommentThread | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== STAGED_SCHEME) {
      void vscode.window.showInformationMessage(
        'Select lines in a Swage diff to comment on them for the agent.',
      );
      return undefined;
    }
    const sel = editor.selection;
    const thread = this.controller.createCommentThread(
      editor.document.uri,
      new vscode.Range(sel.start.line, 0, sel.end.line, 0),
      [],
    );
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    return thread;
  }

  /** Saves the text typed in a thread's box as a comment for the agent. */
  save(reply: { thread: vscode.CommentThread; text: string }): ReviewComment | undefined {
    const { thread } = reply;
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === thread.uri.toString(),
    );
    const quote = doc
      ? doc.getText(new vscode.Range(range.start.line, 0, range.end.line + 1, 0))
      : '';
    const comment = this.queue.add({
      path: pathOf(thread.uri),
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      quote,
      text: reply.text,
    });
    if (!comment) return undefined;
    thread.comments = [...thread.comments, new SwageComment(reply.text.trim(), comment.id, thread)];
    thread.label = 'For the agent (sent with your next request)';
    thread.canReply = false;
    this.threads.set(comment.id, thread);
    return comment;
  }

  remove(id: string): void {
    this.queue.remove(id);
    const thread = this.threads.get(id);
    this.threads.delete(id);
    thread?.dispose();
  }

  /** Clears every comment (they were sent, or the user cleared them). */
  clear(): void {
    this.queue.clear();
    for (const t of this.threads.values()) t.dispose();
    this.threads.clear();
  }

  /** The request text with the comments attached; the threads close once they are sent. */
  attach(prompt: string): string {
    const text = this.queue.attach(prompt);
    if (text !== prompt) this.clear();
    return text;
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) d.dispose();
  }
}
