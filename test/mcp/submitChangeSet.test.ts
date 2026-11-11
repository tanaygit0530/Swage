import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declareContext } from '../../src/mcp/tools/declareContext';
import { stageEdit } from '../../src/mcp/tools/stageEdit';
import { submitChangeSet } from '../../src/mcp/tools/submitChangeSet';
import { startHarness, treeHash, type Harness } from './harness';

const submitted: string[] = [];
let h: Harness;
beforeAll(async () => {
  h = await startHarness([declareContext, stageEdit, submitChangeSet], {
    files: {
      'a.py': 'def keep():\n    pass\n\n\ndef gone():\n    pass\n',
      'b.py': 'from a import gone\n\ngone()\n',
    },
    context: { events: { onSubmit: (t, s) => submitted.push(`${t}: ${s}`) } },
  });
});
afterAll(() => h.close());

describe('submit_change_set', () => {
  it('refuses to submit an empty change set', async () => {
    h.ctx.tasks.start('t1');
    const r = JSON.parse(
      h.text(await h.call('submit_change_set', { summary: 'nothing to see here' })),
    );
    expect(r.error.code).toBe('nothing_staged');
  });

  it('marks the change set submitted, applies nothing, warns the reviewer, and is idempotent', async () => {
    const task = h.ctx.tasks.start('t2');
    const before = treeHash(h.root);
    await h.call('declare_context', {
      plan: ['remove gone'],
      files: [
        { path: 'a.py', reason: 'delete gone' },
        { path: 'c.py', reason: 'new file' },
      ],
    });
    await h.call('stage_edit', {
      path: 'a.py',
      kind: 'edit',
      edits: [{ find: '\n\ndef gone():\n    pass\n', replace: '\n' }],
    });
    await h.call('stage_edit', { path: 'c.py', kind: 'write', content: 'X = 1\n' });
    const first = h.text(
      await h.call('submit_change_set', { summary: 'Removed gone and added c.py' }),
    );
    expect(first).toContain(
      'Submitted change set t2 for review: 2 file(s), 2 block(s). Nothing has been applied to the workspace.',
    );
    expect(first).toContain('- modify a.py: 1 block(s)');
    expect(first).toContain('- create c.py: 1 block(s)');
    expect(first).toContain(
      'Warning for the reviewer: function gone was removed from a.py but is still referenced in b.py',
    );
    expect(task.changeSet.status).toBe('submitted');
    expect(treeHash(h.root)).toBe(before);
    expect(submitted).toEqual(['t2: Removed gone and added c.py']);

    const second = h.text(await h.call('submit_change_set', { summary: 'a different summary' }));
    expect(second).toBe(first);
    expect(submitted).toHaveLength(1);

    const late = JSON.parse(
      h.text(await h.call('stage_edit', { path: 'c.py', kind: 'write', content: 'X = 2\n' })),
    );
    expect(late.error.code).toBe('not_staging');
  });
});
