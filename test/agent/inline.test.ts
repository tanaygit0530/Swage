import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANCELLED_MESSAGE } from '../../src/agent/run';
import type { InlineOutcome } from '../../src/inline/run';
import { ReviewSession } from '../../src/review/session';
import { treeHash } from '../mcp/harness';
import { startInline, waitFor, type InlineHarness } from './harness';

let h: InlineHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const FLAGS = 'app/flags.py';
const TASK_A =
  "In get_debug_flag, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

type Review = Extract<InlineOutcome, { kind: 'review' }>;

function review(outcome: InlineOutcome): Review {
  if (outcome.kind !== 'review')
    throw new Error(`expected a review, got ${outcome.kind}: ${outcome.message}`);
  return outcome;
}

/** The workspace file as it would be after applying the accepted blocks. */
function resultOf(r: Review, file = FLAGS): string {
  const change = r.changeSet.result().changes.find((c) => c.path === file);
  if (!change || change.op === 'delete') throw new Error(`no change for ${file}`);
  return change.content;
}

/** The staged proposal for the file, before any decision. */
function stagedOf(r: Review, file = FLAGS): string {
  const view = r.changeSet.staged(file);
  if (!view || view.deleted) throw new Error(`nothing staged for ${file}`);
  return view.content;
}

const tools = (x: InlineHarness): string[] =>
  x.fake.log.filter((l) => l.startsWith('tool ')).map((l) => l.split(' ')[1] ?? '');

describe('inline edit with the scripted model (blueprint sections 3 and 10, Task A)', () => {
  it('logic change plus docstring: two blocks, each accepted or rejected on its own; disk untouched', async () => {
    h = await startInline('inline-logic-docstring', {
      path: FLAGS,
      instruction: TASK_A,
      cursorLine: 9,
    });
    expect(h.request.range).toEqual({ startLine: 5, endLine: 10 }); // the function around the cursor
    const before = treeHash(h.root);
    const r = review(await h.edit.start());
    expect(r.fallback).toBe(false);
    expect(r.outside.size).toBe(0);
    const [file] = r.changeSet.review();
    expect(file?.path).toBe(FLAGS);
    expect(file?.blocks).toHaveLength(2);
    expect(h.statuses).toContain('Staging the edit…');
    expect(h.statuses.some((s) => s.includes('as false.'))).toBe(true); // streamed text reached the status bar

    // Per-block review through the same session the editor uses: reject block 1, accept block 2.
    const session = new ReviewSession(r.taskId, r.changeSet);
    const [doc, logic] = session.preview(FLAGS).blocks;
    session.reject(FLAGS, doc?.id ?? '');
    session.accept(FLAGS, logic?.id ?? '');
    const partial = resultOf(r);
    expect(partial).toContain('{"0", "false", "no", "off", "n"}');
    expect(partial).not.toContain('"off" and "n" are treated as false');
    // Revert block 1: accept it too.
    session.accept(FLAGS, doc?.id ?? '');
    expect(resultOf(r)).toContain('"off" and "n" are treated as false, in any letter case');
    expect(treeHash(h.root)).toBe(before);
  });

  it('a pure insertion is one block with no removed lines', async () => {
    h = await startInline('inline-insert', {
      path: FLAGS,
      instruction: 'Strip whitespace from the port',
      cursorLine: 15,
    });
    const r = review(await h.edit.start());
    const blocks = r.changeSet.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.oldLines).toEqual([]);
    expect(blocks[0]?.newLines).toEqual(['    val = val.strip() if val else val\n']);
    expect(r.outside.size).toBe(0);
  });

  it('a pure deletion is one block with no added lines', async () => {
    h = await startInline('inline-delete', {
      path: FLAGS,
      instruction: 'Remove the print',
      range: { startLine: 13, endLine: 19 },
    });
    const r = review(await h.edit.start());
    const blocks = r.changeSet.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.newLines).toEqual([]);
    expect(blocks[0]?.oldLines).toEqual(['    print("using DEMO_PORT")\n']);
    expect(stagedOf(r)).not.toContain('print(');
  });

  it('a rename changes the def line only', async () => {
    h = await startInline('inline-rename', {
      path: FLAGS,
      instruction: 'Rename to identity',
      cursorLine: 23,
    });
    expect(h.request.range).toEqual({ startLine: 22, endLine: 24 });
    const r = review(await h.edit.start());
    const blocks = r.changeSet.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.newLines).toEqual(['def identity(value):\n']);
    expect(stagedOf(r)).not.toContain('legacy_name');
  });

  it('an anchor that misses is reported to the model, which retries and succeeds', async () => {
    h = await startInline('inline-anchor-retry', {
      path: FLAGS,
      instruction: TASK_A,
      cursorLine: 9,
    });
    const r = review(await h.edit.start());
    expect(tools(h)).toEqual(['declare_context', 'stage_edit', 'stage_edit']);
    expect(h.fake.log.some((l) => /anchor_not_found/.test(l))).toBe(true);
    expect(h.statuses).toContain('The edit did not apply; the model is retrying…');
    const blocks = r.changeSet.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(stagedOf(r)).toContain('{"0", "false", "no", "off", "n"}');
  });

  it('Escape mid-stream cancels through the agent-mode path; nothing is staged or written', async () => {
    h = await startInline('inline-cancel', { path: FLAGS, instruction: TASK_A, cursorLine: 9 });
    const before = treeHash(h.root);
    const running = h.edit.start();
    await waitFor(
      () => (h?.statuses ?? []).some((s) => s.includes('thinking3')),
      10_000,
      'streamed text',
    );
    const t0 = performance.now();
    const cancelling = h.edit.cancel();
    expect(h.edit.run.state).toBe('cancelled');
    expect(performance.now() - t0).toBeLessThan(50);
    await cancelling;
    const outcome = await running;
    expect(outcome).toEqual({ kind: 'cancelled', message: CANCELLED_MESSAGE });
    await waitFor(() => !h?.edit.run.draining, 15_000, 'stream drained');
    expect(h.fake.log).toContain('session.cancel sess-1');
    expect(tools(h)).toEqual([]);
    const task = h.ctx.tasks.get(h.edit.taskId);
    expect(task?.cancelled).toBe(true);
    expect(task?.changeSet.stagedPaths()).toEqual([]);
    expect(treeHash(h.root)).toBe(before);
  });

  it('a reply with a code block and no tool call goes through the same review (fenced fallback)', async () => {
    h = await startInline('inline-fenced', {
      path: FLAGS,
      instruction: 'Simplify get_port',
      cursorLine: 14,
    });
    const r = review(await h.edit.start());
    expect(r.fallback).toBe(true);
    expect(r.message).toMatch(/code block/);
    const after = stagedOf(r);
    expect(after).toContain('    return int(val) if val else default\n');
    // Only the selection changed: the rest of the file is byte-identical.
    const original = readFileSync(path.join(h.root, FLAGS), 'utf8');
    expect(after.slice(0, original.indexOf('def get_port'))).toBe(
      original.slice(0, original.indexOf('def get_port')),
    );
    expect(after.endsWith(original.slice(original.indexOf('\n\ndef legacy_name')))).toBe(true);
    expect(r.outside.size).toBe(0);
  });

  it('flags blocks outside the selection (range lock) in the result and in the tool reply', async () => {
    // Only the return line is selected; the scripted model also edits the docstring.
    h = await startInline('inline-logic-docstring', {
      path: FLAGS,
      instruction: TASK_A,
      range: { startLine: 9, endLine: 10 },
    });
    const r = review(await h.edit.start());
    expect(r.outside.get(FLAGS)).toHaveLength(1);
    expect(r.message).toMatch(/outside the selection/);
    expect(h.fake.log.some((l) => /outside app\/flags\.py 9-10/.test(l))).toBe(true);
  });

  it('a reply with neither a tool call nor code proposes nothing and leaves no task behind', async () => {
    h = await startInline(
      { name: 'inline-nothing', steps: [{ text: ['I would rather not change this.'] }] },
      { path: FLAGS, instruction: 'Do nothing', cursorLine: 9 },
    );
    const outcome = await h.edit.start();
    expect(outcome.kind).toBe('nothing');
    expect(outcome.message).toContain('I would rather not change this.');
    expect(h.ctx.tasks.get(h.edit.taskId)?.cancelled).toBe(true);
  });
});
