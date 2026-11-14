import * as vscode from 'vscode';
import type { WorkspaceFs, WriteStep } from '../../changeset/apply';

/**
 * The apply engine's file system in VS Code (blueprint section 8, step 2): every write of an
 * apply or undo goes into one WorkspaceEdit, applied all or nothing, then saved. Reads see an
 * open document's current text, so unsaved edits count as a change and block a silent overwrite.
 */
export class VsCodeWorkspaceFs implements WorkspaceFs {
  constructor(private readonly root: vscode.Uri) {}

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...path.split('/'));
  }

  async read(path: string): Promise<string | undefined> {
    const uri = this.uri(path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open?.isDirty) return open.getText();
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  // The per-file methods are only a fallback; writeAll is always used in VS Code.
  async write(path: string, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(this.uri(path), new TextEncoder().encode(content));
  }

  async remove(path: string): Promise<void> {
    await vscode.workspace.fs.delete(this.uri(path), { useTrash: false });
  }

  async writeAll(steps: readonly WriteStep[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const replaced: { uri: vscode.Uri; content: string }[] = [];
    for (const step of steps) {
      const uri = this.uri(step.path);
      if (step.to === undefined) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
      } else if (step.from === undefined) {
        edit.createFile(uri, { overwrite: true, contents: new TextEncoder().encode(step.to) });
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), step.to);
        replaced.push({ uri, content: step.to });
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error('VS Code refused the workspace edit');
    }
    for (const { uri } of replaced) {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) await doc.save();
    }
    // A save participant (format on save, trim whitespace) or another extension may change the
    // bytes after the write. That is checked and reported by the caller, never silently undone
    // or re-applied (review upgrade, step 8).
  }
}
