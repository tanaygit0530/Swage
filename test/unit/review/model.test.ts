import { describe, expect, it } from 'vitest';
import { Applier, type WorkspaceFs, type WriteStep } from '../../../src/changeset/apply';
import { ChangeSet } from '../../../src/changeset/changeSet';
import { hashText } from '../../../src/changeset/text';
import { describeStats, fileStats, preview, totals } from '../../../src/review/model';

const BASE = 'a\nb\nc\nd\ne\nf\n';

async function staged(content: string, base = BASE): Promise<ChangeSet> {
  const cs = new ChangeSet('t', { read: (p) => Promise.resolve(p === 'f.txt' ? base : undefined) });
  cs.declareContext({
    plan: [],
    files: [
      { path: 'f.txt', reason: 'r' },
      { path: 'new.txt', reason: 'r' },
    ],
  });
  await cs.stage({ kind: 'write', path: 'f.txt', content });
  return cs;
}

describe('preview', () => {
  it('shows every block that is not rejected, with live positions', async () => {
    // Block 1 replaces b with B1,B2 (one more line); block 2 deletes e.
    const cs = await staged('a\nB1\nB2\nc\nd\nf\n');
    const blocks = cs.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    let p = preview(BASE, blocks);
    expect(p.content).toBe('a\nB1\nB2\nc\nd\nf\n');
    expect(p.blocks.map((b) => [b.start, b.end, b.added, b.removed])).toEqual([
      [1, 3, 2, 1],
      [5, 5, 0, 1],
    ]);

    cs.reject('f.txt', blocks[0]?.id ?? '');
    p = preview(BASE, cs.review()[0]?.blocks ?? []);
    expect(p.content).toBe('a\nb\nc\nd\nf\n');
    // The rejected block shows the original line; the next block moves up.
    expect(p.blocks.map((b) => [b.state, b.start, b.end])).toEqual([
      ['rejected', 1, 2],
      ['pending', 4, 4],
    ]);
  });

  it('handles one block and many blocks alike', async () => {
    const one = await staged('A\nb\nc\nd\ne\nf\n');
    expect(preview(BASE, one.review()[0]?.blocks ?? []).blocks).toHaveLength(1);
    const many = await staged('A\nb\nC\nd\nE\nf\n');
    const p = preview(BASE, many.review()[0]?.blocks ?? []);
    expect(p.blocks.map((b) => b.start)).toEqual([0, 2, 4]);
  });

  it('computes file stats, totals and a description', async () => {
    const cs = await staged('a\nB1\nB2\nc\nd\nf\n');
    const [b1] = cs.review()[0]?.blocks ?? [];
    cs.accept('f.txt', b1?.id ?? '');
    const file = cs.review()[0];
    if (!file) throw new Error('no file');
    expect(fileStats(file)).toEqual({
      blocks: 2,
      added: 2,
      removed: 2,
      accepted: 1,
      rejected: 0,
      pending: 1,
    });
    expect(describeStats(fileStats(file))).toBe('+2 -2 · 2 blocks (1 accepted, 1 pending)');
    expect(totals([file, file])).toMatchObject({ files: 2, blocks: 4, accepted: 2 });
    expect(
      describeStats({ blocks: 1, added: 1, removed: 0, accepted: 0, rejected: 0, pending: 0 }),
    ).toBe('+1 -0 · 1 block');
  });
});

describe('ChangeSet.rebase', () => {
  it('keeps the staged result and recomputes pending blocks against the new base', async () => {
    const cs = await staged('a\nB\nc\nd\ne\nf\n');
    cs.acceptAll();
    const userEdited = 'a\nb\nc\nd\ne\nf\ng\n';
    const summary = cs.rebase('f.txt', userEdited);
    expect(summary?.blockCount).toBe(2);
    expect(cs.review()[0]?.blocks.every((b) => b.state === 'pending')).toBe(true);
    expect(cs.base('f.txt')).toBe(userEdited);
    cs.acceptAll();
    const [change] = cs.result().changes;
    expect(change).toMatchObject({
      op: 'modify',
      baseHash: hashText(userEdited),
      content: 'a\nB\nc\nd\ne\nf\n',
    });
    expect(cs.rebase('missing.txt', 'x')).toBeUndefined();
  });

  it('turns a modify into a create when the file disappeared, and keeps deletes', async () => {
    const cs = await staged('a\nB\nc\nd\ne\nf\n');
    expect(cs.rebase('f.txt', undefined)).toMatchObject({ kind: 'create' });
    const del = new ChangeSet('t', { read: () => Promise.resolve('x\n') });
    del.declareContext({ plan: [], files: [{ path: 'g.txt', reason: 'r' }] });
    await del.stage({ kind: 'delete', path: 'g.txt' });
    expect(del.rebase('g.txt', 'y\n')).toMatchObject({ kind: 'delete' });
  });
});

describe('Applier with an atomic batch writer', () => {
  class BatchFs implements WorkspaceFs {
    files = new Map<string, string>([['f.txt', BASE]]);
    batches: WriteStep[][] = [];
    fail = false;
    read(p: string): Promise<string | undefined> {
      return Promise.resolve(this.files.get(p));
    }
    write(): Promise<void> {
      return Promise.reject(new Error('per-file write must not be used'));
    }
    remove(): Promise<void> {
      return Promise.reject(new Error('per-file remove must not be used'));
    }
    writeAll(steps: readonly WriteStep[]): Promise<void> {
      if (this.fail) return Promise.reject(new Error('edit refused'));
      this.batches.push([...steps]);
      for (const s of steps) {
        if (s.to === undefined) this.files.delete(s.path);
        else this.files.set(s.path, s.to);
      }
      return Promise.resolve();
    }
  }

  it('applies and undoes in one batch each', async () => {
    const fs = new BatchFs();
    const applier = new Applier(fs);
    const r = await applier.apply('t', [
      { op: 'modify', path: 'f.txt', baseHash: hashText(BASE), content: 'changed\n' },
      { op: 'create', path: 'new.txt', content: 'n\n' },
    ]);
    expect(r.ok).toBe(true);
    expect(fs.batches).toHaveLength(1);
    expect(fs.batches[0]?.map((s) => s.path)).toEqual(['f.txt', 'new.txt']);
    expect((await applier.undo()).ok).toBe(true);
    expect(fs.batches).toHaveLength(2);
    expect(fs.files.get('f.txt')).toBe(BASE);
    expect(fs.files.has('new.txt')).toBe(false);
  });

  it('reports a refused batch without recording a checkpoint', async () => {
    const fs = new BatchFs();
    fs.fail = true;
    const applier = new Applier(fs);
    const r = await applier.apply('t', [
      { op: 'modify', path: 'f.txt', baseHash: hashText(BASE), content: 'x\n' },
    ]);
    expect(r).toMatchObject({ ok: false, error: { code: 'write_failed', rolledBack: true } });
    expect(applier.canUndo).toBe(false);
    expect(fs.files.get('f.txt')).toBe(BASE);
  });
});
