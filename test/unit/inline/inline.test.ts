import { describe, expect, it } from 'vitest';
import { computeBlocks } from '../../../src/changeset/blocks';
import type { CodeSymbol } from '../../../src/context/symbols';
import {
  buildInlineMessage,
  editRange,
  enclosingSymbol,
  importLines,
  sliceLines,
} from '../../../src/inline/context';
import { extractFencedCode, replaceRange } from '../../../src/inline/fenced';
import { blockInRange, blocksOutside, rangeWarning } from '../../../src/inline/rangeLock';
import { tail } from '../../../src/inline/run';

const sym = (
  name: string,
  kind: CodeSymbol['kind'],
  line: number,
  endLine: number,
): CodeSymbol => ({
  name,
  kind,
  line,
  endLine,
  exported: true,
});

const SYMBOLS = [
  sym('Box', 'class', 1, 10),
  sym('open', 'method', 3, 6),
  sym('LIMIT', 'constant', 12, 12),
];

const FILE = [
  'import os',
  'from typing import Any',
  '',
  'def f(x):',
  '    """Doc."""',
  '    return x + 1',
  '',
  'def g():',
  '    return 2',
  '',
].join('\n');

describe('inline context', () => {
  it('finds the innermost function, method or class around a line', () => {
    expect(enclosingSymbol(SYMBOLS, 4)?.name).toBe('open');
    expect(enclosingSymbol(SYMBOLS, 8)?.name).toBe('Box');
    expect(enclosingSymbol(SYMBOLS, 12)).toBeUndefined(); // constants are not edit targets
    expect(enclosingSymbol([], 1)).toBeUndefined();
  });

  it('uses the selection, else the enclosing function, else the cursor line', () => {
    expect(editRange(SYMBOLS, { startLine: 2, endLine: 4, endCharacter: 5, empty: false })).toEqual(
      { startLine: 2, endLine: 4 },
    );
    // A selection ending at column 0 does not include that line.
    expect(editRange(SYMBOLS, { startLine: 2, endLine: 4, endCharacter: 0, empty: false })).toEqual(
      { startLine: 2, endLine: 3 },
    );
    expect(editRange(SYMBOLS, { startLine: 4, endLine: 4, endCharacter: 0, empty: false })).toEqual(
      { startLine: 4, endLine: 4 },
    );
    expect(editRange(SYMBOLS, { startLine: 5, endLine: 5, endCharacter: 2, empty: true })).toEqual({
      startLine: 3,
      endLine: 6,
    });
    expect(
      editRange(SYMBOLS, { startLine: 20, endLine: 20, endCharacter: 0, empty: true }),
    ).toEqual({ startLine: 20, endLine: 20 });
  });

  it('collects Python and JavaScript import lines', () => {
    expect(importLines(FILE)).toEqual(['import os', 'from typing import Any']);
    expect(
      importLines(
        "import { a } from './a';\nconst b = require('b');\nexport { c } from './c';\nconst d = 1;\n",
      ),
    ).toEqual(["import { a } from './a';", "const b = require('b');", "export { c } from './c';"]);
  });

  it('slices 1-based inclusive lines and clamps', () => {
    expect(sliceLines('a\nb\nc', 2, 3)).toBe('b\nc');
    expect(sliceLines('a\nb\n', 0, 9)).toBe('a\nb\n');
  });

  it('builds a first message with the selection, symbol, imports, nearby lines and the editable range', () => {
    const symbols = [sym('f', 'function', 4, 6), sym('g', 'function', 8, 9)];
    const m = buildInlineMessage({
      instruction: 'Add two instead',
      path: 'pkg/m.py',
      text: FILE,
      range: { startLine: 6, endLine: 6 },
      symbols,
    });
    expect(m.text).toContain('Instruction:\nAdd two instead');
    expect(m.text).toContain('Editable range: pkg/m.py lines 6-6');
    expect(m.text).toContain('<<<SELECTION pkg/m.py lines 6-6>>>\n    return x + 1\n<<<END>>>');
    expect(m.text).toContain('Enclosing function f');
    expect(m.text).toContain('<<<SYMBOL pkg/m.py lines 4-6>>>');
    expect(m.text).toContain('Imports in pkg/m.py:\nimport os\nfrom typing import Any');
    expect(m.text).toContain('<<<BEFORE pkg/m.py lines 1-5>>>');
    expect(m.text).toContain('<<<AFTER pkg/m.py lines 7-9>>>');
    expect(m.text).toContain('"path": "pkg/m.py"');
    expect(m.parts.map((p) => p.label)).toEqual([
      'instruction',
      'selection',
      'symbol',
      'imports',
      'nearby',
    ]);
    expect(m.used).toBeGreaterThan(0);
    expect(m.total).toBeGreaterThanOrEqual(m.used);
    expect(m.hints).toEqual([]);
  });

  it('leaves out the symbol when the selection is the whole symbol, and empty sections', () => {
    const m = buildInlineMessage({
      instruction: 'x',
      path: 'a.py',
      text: 'def f():\n    return 1\n',
      range: { startLine: 1, endLine: 2 },
      symbols: [sym('f', 'function', 1, 2)],
    });
    expect(m.text).not.toContain('<<<SYMBOL');
    expect(m.text).not.toContain('Imports in');
    expect(m.text).not.toContain('Nearby lines');
  });
});

describe('range lock', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const range = { path: 'f.py', startLine: 2, endLine: 3 };

  it('accepts changes, insertions and deletions inside the range and flags the rest', () => {
    const inside = computeBlocks(base, 'a\nB\nc\nd\ne\n');
    expect(inside.every((b) => blockInRange(b, range))).toBe(true);
    const insertAtEnd = computeBlocks(base, 'a\nb\nc\nnew\nd\ne\n'); // between line 3 and 4
    expect(insertAtEnd.length === 1 && insertAtEnd.every((b) => blockInRange(b, range))).toBe(true);
    const deletion = computeBlocks(base, 'a\nc\nd\ne\n');
    expect(deletion.length === 1 && deletion.every((b) => blockInRange(b, range))).toBe(true);
    const outside = computeBlocks(base, 'A\nB\nc\nd\nE\n');
    expect(blocksOutside('f.py', outside, range)).toHaveLength(2);
    const insertFar = computeBlocks(base, 'a\nb\nc\nd\ne\nz\n');
    expect(blocksOutside('f.py', insertFar, range)).toHaveLength(1);
  });

  it('flags every block of another file, and nothing without a range', () => {
    const blocks = computeBlocks(base, 'x\n');
    expect(blocksOutside('other.py', blocks, range)).toEqual(blocks.map((b) => b.id));
    expect(blocksOutside('f.py', blocks, undefined)).toEqual([]);
    expect(rangeWarning('other.py', blocks, range)).toMatch(/other\.py is outside the inline edit/);
    expect(rangeWarning('f.py', computeBlocks(base, 'A\nb\nc\nd\ne\n'), range)).toMatch(
      /1 block\(s\) change lines outside f\.py 2-3/,
    );
    expect(rangeWarning('f.py', computeBlocks(base, 'a\nB\nc\nd\ne\n'), range)).toBeUndefined();
    expect(rangeWarning('f.py', blocks, undefined)).toBeUndefined();
  });
});

describe('fenced-code fallback', () => {
  it('extracts the largest fenced block, with any fence style', () => {
    expect(extractFencedCode('Here:\n```python\nx = 1\ny = 2\n```\nand\n```\nz\n```')).toBe(
      'x = 1\ny = 2',
    );
    expect(extractFencedCode('~~~\nonly\n~~~')).toBe('only');
    expect(extractFencedCode('no code here')).toBeUndefined();
    expect(extractFencedCode('```js\nunterminated')).toBeUndefined();
  });

  it('replaces the range and keeps the file around it byte-identical', () => {
    const text = 'a\nb\nc\nd\n';
    expect(replaceRange(text, { startLine: 2, endLine: 3 }, 'B\nC')).toBe('a\nB\nC\nd\n');
    expect(replaceRange(text, { startLine: 2, endLine: 3 }, 'B\n')).toBe('a\nB\nd\n');
    expect(replaceRange(text, { startLine: 2, endLine: 2 }, '')).toBe('a\nc\nd\n');
    expect(replaceRange('a\r\nb\r\n', { startLine: 1, endLine: 1 }, 'x\ny')).toBe(
      'x\r\ny\r\nb\r\n',
    );
    expect(replaceRange('a\nlast', { startLine: 2, endLine: 2 }, 'end')).toBe('a\nend');
  });
});

describe('status tail', () => {
  it('shows the end of the reply on one line', () => {
    expect(tail('short  text\n')).toBe('short text');
    expect(tail('x'.repeat(100), 10)).toBe(`…${'x'.repeat(9)}`);
  });
});
