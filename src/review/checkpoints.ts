import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Checkpoint } from '../changeset/apply';

/**
 * Undo history on disk (blueprint section 8): the Applier's checkpoints for one workspace root,
 * stored as JSON in VS Code's global storage (never in the workspace), so `Undo last change set`
 * survives a window reload. Checkpoints hold the original file contents; they stay on this machine.
 */

export const CHECKPOINT_VERSION = 1;

export function checkpointFile(storageDir: string, root: string): string {
  return path.join(
    storageDir,
    `checkpoints-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`,
  );
}

export function loadCheckpoints(file: string, root: string): Checkpoint[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: number;
      root?: string;
      history?: Checkpoint[];
    };
    if (data.version !== CHECKPOINT_VERSION || data.root !== root || !Array.isArray(data.history))
      return [];
    return data.history;
  } catch {
    return [];
  }
}

export function saveCheckpoints(file: string, root: string, history: readonly Checkpoint[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: CHECKPOINT_VERSION, root, history }));
  renameSync(tmp, file);
}
