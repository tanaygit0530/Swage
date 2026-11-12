// VS Code's IPC socket lives in its user-data folder, and macOS and Linux cap socket paths at
// about 103 characters. The default (.vscode-test/user-data inside the repository) is too long
// when the repository sits in a deep folder, and VS Code then fails with "listen EINVAL". In that
// case the test configurations use a short folder in /tmp, one per repository.
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export function userDataArgs(repo = process.cwd()) {
  if (process.platform === 'win32') return [];
  const fallback = path.join(repo, '.vscode-test', 'user-data');
  if (`${fallback}/1.99-main.sock`.length <= 100) return [];
  const id = createHash('sha256').update(repo).digest('hex').slice(0, 10);
  return [`--user-data-dir=/tmp/swage-vscode-${id}`];
}
