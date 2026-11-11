import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { PrimarySnapshot } from './primary';

/**
 * What break-primary changed, so restore-primary can undo it. Kept in ~/.swage, outside every
 * repository, so the demo's `git status` stays clean.
 */
export interface BreakState {
  readonly version: 1;
  readonly createdAt: string;
  readonly mode: 'url' | 'fake';
  readonly brokenModel: string;
  /** The temporary TrueForge provider (url mode). */
  readonly provider?: string;
  readonly baseUrl: string;
  readonly files: readonly { readonly file: string; readonly original: PrimarySnapshot }[];
}

export const STATE_FILE = path.join(homedir(), '.swage', 'break-primary.json');

export function loadState(file = STATE_FILE): BreakState | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as BreakState;
}

export function saveState(state: BreakState, file = STATE_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearState(file = STATE_FILE): void {
  rmSync(file, { force: true });
}
