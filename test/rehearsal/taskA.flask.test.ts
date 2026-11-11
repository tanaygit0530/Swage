import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rehearseTaskA } from './taskA';

/**
 * Task A rehearsal on a clone of Flask 3.1.3 (blueprint section 10). Needs SWAGE_FLASK_DIR
 * pointing at the checkout, with a .venv that has Flask's test dependencies; skipped otherwise.
 * `npm run rehearse:task-a` runs it and prints the transcript.
 */
const FLASK = process.env.SWAGE_FLASK_DIR;

describe.skipIf(!FLASK)('Task A rehearsal on Flask 3.1.3', () => {
  it('cancel demo, two-block inline edit, per-block review, apply, verification, undo', async () => {
    const lines: string[] = [];
    const report = await rehearseTaskA(path.resolve(FLASK ?? ''), (l = '') => {
      lines.push(l);
      if (process.env.SWAGE_REHEARSAL_PRINT === '1') process.stdout.write(`${l}\n`);
    });
    expect(report.a0).toEqual({
      outcome: 'cancelled: Cancelled. Workspace unchanged.',
      tools: 0,
      status: '',
    });
    expect(report.blocks).toBe(2);
    expect(report.verification).toBe('False');
    for (const v of ['OFF', 'n', 'N', 'no', 'False', '0'])
      expect(report.values[v], v).toBe('False');
    for (const v of ['1', 'on', 'yes']) expect(report.values[v], v).toBe('True');
    // The edit changes no test outcome: the same tests fail before and after (an environment
    // gap such as the missing async extra), and the get_debug_flag tests pass.
    expect(report.pytest.replace(/ in [\d.]+s/, '')).toBe(
      report.pytestBaseline.replace(/ in [\d.]+s/, ''),
    );
    expect(report.debugFlagTests).toMatch(/^\d+ passed/);
    expect(report.statusAfterUndo).toBe('');
    expect(report.undoAgain).toBe('nothing_to_undo');
  }, 120_000);
});
