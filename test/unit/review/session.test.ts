import { describe, expect, it } from 'vitest';
import { ChangeSet } from '../../../src/changeset/changeSet';
import { ReviewSession } from '../../../src/review/session';

async function session(): Promise<ReviewSession> {
  const files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\ny\n' };
  const cs = new ChangeSet('t', { read: (p) => Promise.resolve(files[p]) });
  cs.declareContext({ plan: [], files: ['a.txt', 'b.txt'].map((path) => ({ path, reason: 'r' })) });
  await cs.stage({ kind: 'write', path: 'a.txt', content: 'ONE\ntwo\nTHREE\n' });
  await cs.stage({ kind: 'write', path: 'b.txt', content: 'x\nY\n' });
  return new ReviewSession('t', cs);
}

describe('ReviewSession', () => {
  it('notifies listeners on every decision and keeps the preview live', async () => {
    const s = await session();
    const changed: string[][] = [];
    const sub = s.onDidChange((paths) => changed.push([...paths]));
    const [b1, b2] = s.file('a.txt')?.blocks ?? [];
    expect(s.preview('a.txt').content).toBe('ONE\ntwo\nTHREE\n');
    expect(s.accept('a.txt', b1?.id ?? '')).toBe(true);
    expect(s.reject('a.txt', b2?.id ?? '')).toBe(true);
    expect(s.preview('a.txt').content).toBe('ONE\ntwo\nthree\n');
    expect(s.accept('a.txt', 'nope')).toBe(false);
    s.rejectFile('b.txt');
    s.acceptFile('b.txt');
    s.acceptAll();
    s.rejectAll();
    expect(changed).toEqual([
      ['a.txt'],
      ['a.txt'],
      ['b.txt'],
      ['b.txt'],
      ['a.txt', 'b.txt'],
      ['a.txt', 'b.txt'],
    ]);
    expect(s.totals()).toMatchObject({ files: 2, blocks: 3, rejected: 3 });
    sub.dispose();
    s.acceptAll();
    expect(changed).toHaveLength(6);
  });

  it('splits a block, rebases, and builds the result from accepted blocks', async () => {
    const s = await session();
    const [b1] = s.file('a.txt')?.blocks ?? [];
    // A one-line-each block cannot be split further; it comes back unchanged.
    expect(s.split('a.txt', b1?.id ?? '')).toEqual([b1?.id]);
    expect(s.split('a.txt', 'nope')).toEqual([]);
    const cs = s.changeSet;
    await cs.stage({ kind: 'write', path: 'b.txt', content: 'X\nY\n' });
    const [merged] = s.file('b.txt')?.blocks ?? [];
    expect(s.split('b.txt', merged?.id ?? '')).toHaveLength(2);
    s.rebase(new Map([['a.txt', 'one\ntwo\nthree\nfour\n']]));
    expect(s.base('a.txt')).toBe('one\ntwo\nthree\nfour\n');
    expect(s.base('missing.txt')).toBe('');
    s.acceptAll();
    expect(s.result().changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(s.preview('missing.txt').content).toBe('');
  });
});

async function four(): Promise<ReviewSession> {
  const files: Record<string, string> = {
    'a.py': 'a1\na2\na3\na4\na5\n',
    'b.py': 'b\n',
    'c.py': 'c\n',
    'd.py': 'd\n',
  };
  const cs = new ChangeSet('t4', { read: (p) => Promise.resolve(files[p]) });
  cs.declareContext({
    plan: [],
    files: [...Object.keys(files), 'new.py'].map((path) => ({ path, reason: 'r' })),
  });
  await cs.stage({ kind: 'write', path: 'd.py', content: 'D\n' });
  await cs.stage({ kind: 'write', path: 'a.py', content: 'A1\na2\na3\na4\nA5\n' });
  await cs.stage({ kind: 'write', path: 'c.py', content: 'C\n' });
  await cs.stage({ kind: 'write', path: 'new.py', content: 'new\n' });
  return new ReviewSession('t4', cs);
}

describe('ReviewSession: per-file review', () => {
  it('orders open files by path and advances through them, wrapping', async () => {
    const s = await four();
    expect(s.openFiles()).toEqual(['a.py', 'c.py', 'd.py', 'new.py']);
    expect(s.nextOpen()).toBe('a.py');
    expect(s.nextOpen('c.py')).toBe('d.py');
    expect(s.nextOpen('new.py')).toBe('a.py');
    expect(s.previousOpen('a.py')).toBe('new.py');
    expect(s.previousOpen('d.py')).toBe('c.py');
  });

  it('accepts a whole pending file for apply, and settles it', async () => {
    const s = await four();
    const change = s.acceptForApply('c.py');
    expect(change).toMatchObject({ op: 'modify', path: 'c.py', content: 'C\n' });
    expect(s.status('c.py')).toBe('accepted');
    s.settle('c.py', 'applied');
    expect(s.status('c.py')).toBe('applied');
    expect(s.openFiles()).toEqual(['a.py', 'd.py', 'new.py']);
    expect(s.applied).toEqual(['c.py']);
    // The rest of the change set no longer includes the applied file.
    expect(s.result().changes.map((c) => c.path)).not.toContain('c.py');
  });

  it('applies exactly the accepted blocks of a partly reviewed file', async () => {
    const s = await four();
    const [first, second] = s.file('a.py')?.blocks ?? [];
    s.reject('a.py', second?.id ?? '');
    // One block decided, one still pending: partly reviewed.
    expect(s.status('a.py')).toBe('partial');
    s.accept('a.py', first?.id ?? '');
    expect(s.status('a.py')).toBe('partial');
    expect(s.acceptForApply('a.py')).toMatchObject({ content: 'A1\na2\na3\na4\na5\n' });
  });

  it('returns nothing to apply when every block of the file is rejected', async () => {
    const s = await four();
    s.rejectFile('d.py');
    expect(s.acceptForApply('d.py')).toBeUndefined();
  });

  it('discards a file, reports every combination, and knows when all are settled', async () => {
    const s = await four();
    s.settle('d.py', 'discarded');
    expect(s.status('d.py')).toBe('discarded');
    expect(s.file('d.py')?.blocks.every((b) => b.state === 'rejected')).toBe(true);
    expect(s.status('a.py')).toBe('pending');
    expect(s.allSettled).toBe(false);
    s.acceptForApply('a.py');
    s.settle('a.py', 'applied');
    s.acceptForApply('new.py');
    s.settle('new.py', 'applied');
    s.settle('c.py', 'discarded');
    expect(s.allSettled).toBe(true);
    expect(s.nextOpen('a.py')).toBeUndefined();
    expect(s.result()).toEqual({ changes: [], accepted: [], rejected: [], pending: [] });
    expect(s.applied.sort()).toEqual(['a.py', 'new.py']);
  });

  it('counts block decisions per open file, with block ids that repeat across files', async () => {
    const s = await four();
    s.acceptFile('c.py');
    s.rejectFile('d.py');
    const r = s.result();
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    s.settle('c.py', 'applied');
    expect(s.result().accepted).toHaveLength(0);
    expect(s.result().rejected).toHaveLength(1);
  });
});
