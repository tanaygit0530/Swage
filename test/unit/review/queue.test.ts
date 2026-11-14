import { describe, expect, it } from 'vitest';
import { ChangeSet } from '../../../src/changeset/changeSet';
import { ReviewQueue } from '../../../src/review/queue';
import { ReviewSession } from '../../../src/review/session';

async function session(taskId: string, files: string[]): Promise<ReviewSession> {
  const cs = new ChangeSet(taskId, { read: () => Promise.resolve('x\n') });
  cs.declareContext({ plan: [], files: files.map((path) => ({ path, reason: 'r' })) });
  for (const f of files) await cs.stage({ kind: 'write', path: f, content: 'y\n' });
  return new ReviewSession(taskId, cs);
}

describe('review queue: one review per turn', () => {
  it('parks the review in progress when a newer turn starts, and resumes it later', async () => {
    const q = new ReviewQueue<string, 'agent'>();
    const t1 = await session('t1', ['a.py', 'b.py']);
    const t2 = await session('t2', ['c.py']);
    q.start({ session: t1, onFinish: 'resume-1', mode: 'agent' });
    t1.acceptForApply('a.py');
    t1.settle('a.py', 'applied');
    q.start({ session: t2, onFinish: 'resume-2', mode: 'agent' });
    expect(q.current?.session.taskId).toBe('t2');
    expect(q.summaries()).toEqual([
      { taskId: 't2', files: 1, open: 1, current: true },
      { taskId: 't1', files: 2, open: 1, current: false },
    ]);
    // The earlier turn comes back with its decisions and its own callback.
    expect(q.resume('t1')).toBe(true);
    expect(q.current?.onFinish).toBe('resume-1');
    expect(q.current?.session.status('a.py')).toBe('applied');
    expect(q.has('t2')).toBe(true);
    expect(q.summaries().map((s) => [s.taskId, s.current])).toEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });

  it('finishes the current review, resumes unknown turns as no-ops, and drops parked turns', async () => {
    const q = new ReviewQueue<undefined, 'agent'>();
    q.start({ session: await session('t1', ['a.py']), onFinish: undefined, mode: 'agent' });
    q.start({ session: await session('t2', ['b.py']), onFinish: undefined, mode: 'agent' });
    expect(q.resume('t2')).toBe(true);
    expect(q.resume('nope')).toBe(false);
    expect(q.finishCurrent()?.session.taskId).toBe('t2');
    expect(q.current).toBeUndefined();
    expect(q.summaries().map((s) => s.taskId)).toEqual(['t1']);
    q.drop('t1');
    expect(q.has('t1')).toBe(false);
    expect(q.summaries()).toEqual([]);
    expect(q.finishCurrent()).toBeUndefined();
  });

  it('restarting the same turn does not park it against itself', async () => {
    const q = new ReviewQueue<undefined, 'agent'>();
    const s = await session('t1', ['a.py']);
    q.start({ session: s, onFinish: undefined, mode: 'agent' });
    q.start({ session: s, onFinish: undefined, mode: 'agent' });
    expect(q.summaries()).toHaveLength(1);
  });
});
