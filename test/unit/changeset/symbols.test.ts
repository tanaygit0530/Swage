import { describe, expect, it } from 'vitest';
import {
  checkDeletedSymbols,
  languageOf,
  regexExtractor,
  type SymbolExtractor,
} from '../../../src/changeset/symbols';

const CLI_BEFORE = `import click


def _path_is_ancestor(path, other):
    return os.path.join(path, other[len(path):].lstrip(os.sep)) == other


class ScriptInfo:
    def load_app(self):
        pass


async def run_async():
    pass


@click.command("routes")
def routes_command():
    """Show all registered routes."""
`;

const TEST_CLI = `from flask.cli import ScriptInfo
from flask.cli import routes_command


def test_routes(runner):
    # routes_command is tested here
    result = runner.invoke(routes_command)
`;

describe('languageOf', () => {
  it('maps extensions to languages', () => {
    expect(languageOf('src/flask/cli.py')).toBe('python');
    expect(languageOf('a.TSX')).toBe('typescript');
    expect(languageOf('a.mjs')).toBe('javascript');
    expect(languageOf('README.md')).toBeUndefined();
    expect(languageOf('Makefile')).toBeUndefined();
  });
});

describe('regexExtractor', () => {
  it('finds top-level Python functions and classes, not methods', () => {
    const names = regexExtractor.extract(CLI_BEFORE, 'python').map((d) => `${d.kind}:${d.name}`);
    expect(names).toEqual([
      'function:_path_is_ancestor',
      'class:ScriptInfo',
      'function:run_async',
      'function:routes_command',
    ]);
  });

  it('finds TypeScript and JavaScript declarations and export lists', () => {
    const src = [
      'export function computeBlocks() {}',
      'export default class Review {}',
      'export const LIMIT = 4;',
      'export interface Block {}',
      'export type Id = string;',
      'export async function* stream() {}',
      'function helper() {}',
      'class Local {}',
      'const arrow = (a) => a;',
      'const single = x => x;',
      'const notAFunction = 3;',
      'export { helper as publicHelper, Local, type Id as Ident };',
      '  function nested() {}',
    ].join('\n');
    const names = regexExtractor.extract(src, 'typescript').map((d) => `${d.kind}:${d.name}`);
    expect(names).toEqual([
      'function:computeBlocks',
      'class:Review',
      'export:LIMIT',
      'export:Block',
      'export:Id',
      'function:stream',
      'function:helper',
      'class:Local',
      'function:arrow',
      'function:single',
      'export:publicHelper',
      'export:Ident',
    ]);
  });
});

describe('checkDeletedSymbols', () => {
  it('warns when a deleted Python function is still referenced in another file', () => {
    const after = CLI_BEFORE.replace(/@click\.command\("routes"\)\ndef routes_command[\s\S]*$/, '');
    const warnings = checkDeletedSymbols([
      { path: 'src/flask/cli.py', before: CLI_BEFORE, after },
      { path: 'tests/test_cli.py', before: TEST_CLI, after: TEST_CLI },
    ]);
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w).toMatchObject({
      symbol: 'routes_command',
      kind: 'function',
      definedIn: 'src/flask/cli.py',
    });
    // The comment line is ignored; the import and the call are kept.
    expect(w?.references.map((r) => r.line)).toEqual([2, 7]);
    expect(w?.message).toMatch(/tests\/test_cli\.py/);
  });

  it('does not warn when the symbol is renamed and every reference is updated', () => {
    const after = CLI_BEFORE.replace('class ScriptInfo', 'class AppInfo');
    const testAfter = TEST_CLI.replace('ScriptInfo', 'AppInfo');
    expect(
      checkDeletedSymbols([
        { path: 'src/flask/cli.py', before: CLI_BEFORE, after },
        { path: 'tests/test_cli.py', before: TEST_CLI, after: testAfter },
      ]),
    ).toEqual([]);
  });

  it('warns about references left in the same file and for a deleted file', () => {
    const before = 'export function a() {}\nexport function b() { return a(); }\n';
    const after = 'export function b() { return a(); }\n';
    const same = checkDeletedSymbols([{ path: 'm.ts', before, after }]);
    expect(same.map((w) => w.symbol)).toEqual(['a']);

    const deleted = checkDeletedSymbols([
      { path: 'util.js', before: 'export const fmt = (x) => x;\n', after: undefined },
      { path: 'main.js', before: undefined, after: "import { fmt } from './util.js';\nfmt(1);\n" },
    ]);
    expect(deleted.map((w) => w.symbol)).toEqual(['fmt']);
    expect(deleted[0]?.references).toHaveLength(2);
  });

  it('ignores a symbol that moved to another file, unknown languages and unmentioned removals', () => {
    expect(
      checkDeletedSymbols([
        { path: 'a.py', before: 'def moved():\n    pass\n', after: '' },
        { path: 'b.py', before: undefined, after: 'def moved():\n    pass\n' },
      ]),
    ).toEqual([]);
    expect(checkDeletedSymbols([{ path: 'notes.md', before: 'def x():', after: '' }])).toEqual([]);
    expect(
      checkDeletedSymbols([{ path: 'a.py', before: 'def unused():\n    pass\n', after: '' }]),
    ).toEqual([]);
  });

  it('does not count a substring as a reference', () => {
    const warnings = checkDeletedSymbols([
      { path: 'a.py', before: 'def run():\n    pass\n', after: '' },
      { path: 'b.py', before: '', after: 'rerun()\nrunner = 1\nrun_x()\n' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('caps the reference list and uses an injected extractor', () => {
    const extractor: SymbolExtractor = {
      extract: (text) =>
        text.includes('KEEP') ? [{ name: 'thing', kind: 'export', line: 1 }] : [],
    };
    const many = Array.from({ length: 10 }, () => 'thing()').join('\n');
    const warnings = checkDeletedSymbols(
      [
        { path: 'a.ts', before: 'KEEP', after: '' },
        { path: 'b.ts', before: '', after: many },
      ],
      { extractor, maxReferences: 3 },
    );
    expect(warnings[0]?.references).toHaveLength(3);
  });
});
