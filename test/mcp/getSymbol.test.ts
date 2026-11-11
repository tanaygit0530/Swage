import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSymbol } from '../../src/mcp/tools/getSymbol';
import { startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness([getSymbol]);
  h.ctx.tasks.start('t1');
});
afterAll(() => h.close());

describe('get_symbol', () => {
  it('returns the definition, its uses and paired tests', async () => {
    const text = h.text(await h.call('get_symbol', { name: 'humanize_delta' }));
    expect(text).toMatch(
      /^humanize_delta is defined in taskboard\/utils\/dates\.py lines \d+-\d+\./,
    );
    expect(text).toContain('def humanize_delta(due, now=None):');
    expect(text).toContain('<<<END FILE>>>');
    expect(text).toMatch(/Used at \(\d+\):\n- tests\/test_dates\.py:\d+/);
    expect(text).toContain('Paired tests: tests/test_dates.py');
  });

  it('resolves Class.method and reports other definitions with the same name', async () => {
    const text = h.text(await h.call('get_symbol', { name: 'SqliteStore.save_task' }));
    expect(text).toMatch(/^SqliteStore\.save_task is defined in taskboard\/storage\/sqlite\.py/);
    expect(text).toMatch(/Other definitions with this name: taskboard\/storage\/memory\.py:\d+/);
  });

  it('says when there are no uses or paired tests', async () => {
    const text = h.text(await h.call('get_symbol', { name: 'notify_due' }));
    expect(text).toContain('No uses found outside the definition.');
    expect(text).toContain('No paired test file found.');
  });

  it('suggests close names for an unknown symbol and validates the name', async () => {
    const r = await h.call('get_symbol', { name: 'humanize_delt' });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('"code": "symbol_not_found"');
    expect(h.text(r)).toContain('Did you mean humanize_delta');
    expect((await h.call('get_symbol', { name: 'not a name' })).isError).toBe(true);
  });
});
