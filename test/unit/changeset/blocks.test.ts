import { describe, expect, it } from 'vitest';
import {
  applyBlocks,
  computeBlocks,
  splitBlock,
  splitBlockByLine,
  type Block,
} from '../../../src/changeset/blocks';
import { joinLines, splitLines } from '../../../src/changeset/text';

/** The real get_debug_flag from Flask 3.1.3 src/flask/helpers.py. */
const HELPERS_BEFORE = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})


def get_load_dotenv(default: bool = True) -> bool:
    """Get whether the user has disabled loading default dotenv files by
    setting :envvar:\`FLASK_SKIP_DOTENV\`. The default is \`\`True\`\`, load
    the files.
`;

/** A typical Task A answer: docstring and logic both change, separated by one unchanged line. */
const HELPERS_TWO_BLOCKS = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.

    The values "0", "false", "no", "off" and "n" (case-insensitive) are
    treated as false.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})


def get_load_dotenv(default: bool = True) -> bool:
    """Get whether the user has disabled loading default dotenv files by
    setting :envvar:\`FLASK_SKIP_DOTENV\`. The default is \`\`True\`\`, load
    the files.
`;

/**
 * The same edit when the model also folds the docstring close into the text and touches
 * the `val =` line, so the three changed lines are adjacent and form a single block.
 */
const HELPERS_ONE_BLOCK = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    Treated as false: "0", "false", "no", "off", "n" (case-insensitive)."""
    val = os.environ.get("FLASK_DEBUG", "")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})


def get_load_dotenv(default: bool = True) -> bool:
    """Get whether the user has disabled loading default dotenv files by
    setting :envvar:\`FLASK_SKIP_DOTENV\`. The default is \`\`True\`\`, load
    the files.
`;

function ids(blocks: readonly Block[]): string[] {
  return blocks.map((b) => b.id);
}

function applyAll(before: string, blocks: readonly Block[]): string {
  return applyBlocks(before, blocks, ids(blocks));
}

describe('computeBlocks', () => {
  it('returns no blocks for identical texts', () => {
    expect(computeBlocks(HELPERS_BEFORE, HELPERS_BEFORE)).toEqual([]);
  });

  it('finds two blocks when a docstring change and a logic change are separated', () => {
    const blocks = computeBlocks(HELPERS_BEFORE, HELPERS_TWO_BLOCKS);
    expect(blocks).toHaveLength(2);
    const [doc, logic] = blocks as [Block, Block];
    expect(doc.oldLines).toEqual([]);
    expect(doc.newLines.join('')).toContain('"off" and "n"');
    expect(logic.oldLines).toHaveLength(1);
    expect(logic.newLines[0]).toContain('"off", "n"');
  });

  it('merges adjacent changes into one block', () => {
    const blocks = computeBlocks(HELPERS_BEFORE, HELPERS_ONE_BLOCK);
    expect(blocks).toHaveLength(1);
    const [only] = blocks as [Block];
    expect(only.oldLines).toHaveLength(3);
    expect(only.newLines).toHaveLength(3);
  });

  it('reproduces the new text when every block is accepted, for any block count', () => {
    for (const after of [HELPERS_TWO_BLOCKS, HELPERS_ONE_BLOCK]) {
      const blocks = computeBlocks(HELPERS_BEFORE, after);
      expect(applyAll(HELPERS_BEFORE, blocks)).toBe(after);
      expect(applyBlocks(HELPERS_BEFORE, blocks, [])).toBe(HELPERS_BEFORE);
    }
  });

  it('accepts only the logic change of a two-block diff', () => {
    const blocks = computeBlocks(HELPERS_BEFORE, HELPERS_TWO_BLOCKS);
    const [, logic] = blocks as [Block, Block];
    const out = applyBlocks(HELPERS_BEFORE, blocks, [logic.id]);
    expect(out).toContain('"off", "n"}');
    expect(out).not.toContain('(case-insensitive)');
  });

  it('accepts only the docstring change of a two-block diff', () => {
    const blocks = computeBlocks(HELPERS_BEFORE, HELPERS_TWO_BLOCKS);
    const [doc] = blocks as [Block, Block];
    const out = applyBlocks(HELPERS_BEFORE, blocks, [doc.id]);
    expect(out).toContain('(case-insensitive)');
    expect(out).toContain('{"0", "false", "no"}');
  });

  it('handles a ten-block diff and every partial acceptance', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
    const after = splitLines(before)
      .map((l, i) => (i % 4 === 1 ? l.replace('line', 'LINE') : l))
      .join('');
    const blocks = computeBlocks(before, after);
    expect(blocks).toHaveLength(10);
    expect(applyAll(before, blocks)).toBe(after);

    const even = blocks.filter((_, i) => i % 2 === 0).map((b) => b.id);
    const out = splitLines(applyBlocks(before, blocks, even));
    for (let k = 0; k < 10; k++) {
      const line = out[k * 4 + 1];
      expect(line).toBe(k % 2 === 0 ? `LINE ${k * 4 + 1}\n` : `line ${k * 4 + 1}\n`);
    }
  });

  it('handles pure deletions, end-of-file additions and an empty base', () => {
    const before = 'a\nb\nc\n';
    const del = computeBlocks(before, 'a\nc\n');
    expect(del).toHaveLength(1);
    expect(del[0]?.newLines).toEqual([]);
    expect(applyAll(before, del)).toBe('a\nc\n');

    const add = computeBlocks(before, 'a\nb\nc\nd\n');
    expect(add[0]?.oldStart).toBe(3);
    expect(applyAll(before, add)).toBe('a\nb\nc\nd\n');

    const created = computeBlocks('', 'x\ny\n');
    expect(created).toHaveLength(1);
    expect(applyAll('', created)).toBe('x\ny\n');

    const emptied = computeBlocks(before, '');
    expect(applyAll(before, emptied)).toBe('');
  });

  it('treats a change of the final newline as a change', () => {
    const blocks = computeBlocks('a\nb', 'a\nb\n');
    expect(blocks).toHaveLength(1);
    expect(applyAll('a\nb', blocks)).toBe('a\nb\n');
  });

  it('keeps CRLF line endings intact', () => {
    const before = 'one\r\ntwo\r\nthree\r\n';
    const after = 'one\r\nTWO\r\nthree\r\n';
    const blocks = computeBlocks(before, after);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.newLines).toEqual(['TWO\r\n']);
    expect(applyAll(before, blocks)).toBe(after);
  });

  it('flags whitespace-only blocks', () => {
    const blocks = computeBlocks('a\n  b\nc\n', 'a\n    b\nc\n');
    expect(blocks[0]?.whitespaceOnly).toBe(true);
    const real = computeBlocks('a\nb\n', 'a\nB\n');
    expect(real[0]?.whitespaceOnly).toBe(false);
  });

  it('gives each block a stable id prefix', () => {
    const blocks = computeBlocks('a\nb\nc\n', 'A\nb\nC\n', 'helpers.py');
    expect(ids(blocks)).toEqual(['helpers.py#1', 'helpers.py#2']);
  });

  it('refuses unknown block ids', () => {
    const blocks = computeBlocks('a\n', 'b\n');
    expect(() => applyBlocks('a\n', blocks, ['nope'])).toThrow(/unknown block/);
  });

  it('refuses a base that does not match the blocks', () => {
    const blocks = computeBlocks('a\nb\n', 'a\nB\n');
    expect(() => applyBlocks('x\ny\n', blocks, ids(blocks))).toThrow(/does not match/);
  });
});

describe('splitBlock', () => {
  it('splits the one-block Task A diff and accepts only the logic part', () => {
    const blocks = computeBlocks(HELPERS_BEFORE, HELPERS_ONE_BLOCK);
    const [only] = blocks as [Block];
    const parts = splitBlockByLine(only);
    expect(parts).toHaveLength(3);
    expect(applyBlocks(HELPERS_BEFORE, parts, ids(parts))).toBe(HELPERS_ONE_BLOCK);

    const returnPart = parts.find((p) => p.newLines.some((l) => l.includes('return bool')));
    expect(returnPart).toBeDefined();
    const out = applyBlocks(HELPERS_BEFORE, parts, [returnPart?.id ?? '']);
    expect(out).toContain('"off", "n"}');
    expect(out).not.toContain('(case-insensitive)');
    expect(out).toContain('os.environ.get("FLASK_DEBUG")\n');
  });

  it('splits at explicit offsets into two independent blocks', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'A\nB\nC\nd\n';
    const [block] = computeBlocks(before, after) as [Block];
    const [first, second] = splitBlock(block, 1, 1);
    expect(first.oldLines).toEqual(['a\n']);
    expect(second.oldLines).toEqual(['b\n', 'c\n']);
    expect(applyBlocks(before, [first, second], [second.id])).toBe('a\nB\nC\nd\n');
    expect(applyBlocks(before, [first, second], [first.id])).toBe('A\nb\nc\nd\n');
  });

  it('can split off a pure insertion that keeps its order', () => {
    const before = 'a\nz\n';
    const after = 'a\nnew1\nnew2\nZ\n';
    const [block] = computeBlocks(before, after) as [Block];
    const [ins, rep] = splitBlock(block, 0, 2);
    expect(ins.oldLines).toEqual([]);
    expect(applyBlocks(before, [ins, rep], [ins.id, rep.id])).toBe(after);
    expect(applyBlocks(before, [ins, rep], [ins.id])).toBe('a\nnew1\nnew2\nz\n');
    expect(applyBlocks(before, [rep, ins], [rep.id])).toBe('a\nZ\n');
  });

  it('splits a split part again', () => {
    const before = 'a\nb\nc\n';
    const after = 'A\nB\nC\n';
    const [block] = computeBlocks(before, after) as [Block];
    const [one, rest] = splitBlock(block, 1, 1);
    const [two, three] = splitBlock(rest, 1, 1);
    expect(ids([one, two, three])).toEqual(['1.1', '1.2.1', '1.2.2']);
    expect(applyBlocks(before, [one, two, three], [two.id])).toBe('a\nB\nc\n');
  });

  it('rejects offsets that would leave an empty part', () => {
    const [block] = computeBlocks('a\nb\n', 'A\nB\n') as [Block];
    expect(() => splitBlock(block, 0, 0)).toThrow(/empty part/);
    expect(() => splitBlock(block, 2, 2)).toThrow(/empty part/);
    expect(() => splitBlock(block, 3, 1)).toThrow(/out of range/);
  });

  it('returns the block itself when it has one line on each side', () => {
    const [block] = computeBlocks('a\n', 'b\n') as [Block];
    expect(splitBlockByLine(block)).toEqual([block]);
  });

  it('round-trips through joinLines', () => {
    const [block] = computeBlocks('a\nb\n', 'c\n') as [Block];
    expect(joinLines(block.oldLines)).toBe('a\nb\n');
  });
});
