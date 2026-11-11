import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Applier, type WorkspaceFs } from '../../../src/changeset/apply';
import { hashText } from '../../../src/changeset/text';
import { checkpointFile, loadCheckpoints, saveCheckpoints } from '../../../src/review/checkpoints';

describe('checkpoint persistence', () => {
  it('saves and reloads the undo history, so undo works after a reload', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swage-cp-'));
    const file = checkpointFile(dir, '/ws');
    expect(file).toMatch(/checkpoints-[0-9a-f]{16}\.json$/);
    expect(checkpointFile(dir, '/other')).not.toBe(file);

    const files = new Map([['a.txt', 'one\n']]);
    const fs: WorkspaceFs = {
      read: (p) => Promise.resolve(files.get(p)),
      write: (p, c) => Promise.resolve(void files.set(p, c)),
      remove: (p) => Promise.resolve(void files.delete(p)),
    };
    const first = new Applier(fs);
    await first.apply('t1', [
      { op: 'modify', path: 'a.txt', baseHash: hashText('one\n'), content: 'two\n' },
    ]);
    await first.apply('t2', [
      { op: 'modify', path: 'a.txt', baseHash: hashText('two\n'), content: 'three\n' },
    ]);
    saveCheckpoints(file, '/ws', first.history);

    // A "reload": a new Applier from the saved history undoes both levels.
    const reloaded = new Applier(fs, { history: loadCheckpoints(file, '/ws') });
    expect((await reloaded.undo()).ok).toBe(true);
    expect(files.get('a.txt')).toBe('two\n');
    expect((await reloaded.undo()).ok).toBe(true);
    expect(files.get('a.txt')).toBe('one\n');
    expect((await reloaded.undo()).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a missing, corrupt, foreign or old file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swage-cp-'));
    const file = path.join(dir, 'c.json');
    expect(loadCheckpoints(file, '/ws')).toEqual([]);
    writeFileSync(file, '{not json');
    expect(loadCheckpoints(file, '/ws')).toEqual([]);
    saveCheckpoints(file, '/other', []);
    expect(loadCheckpoints(file, '/ws')).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 0, root: '/ws', history: [] }));
    expect(loadCheckpoints(file, '/ws')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
