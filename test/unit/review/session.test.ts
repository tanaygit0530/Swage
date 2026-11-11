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
