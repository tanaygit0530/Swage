import { beforeAll, describe, expect, it } from 'vitest';
import {
  createParser,
  grammarOf,
  regexParser,
  toSymbolExtractor,
  type CodeParser,
  type CodeSymbol,
} from '../../../src/context/symbols';

const PY = `"""Command line interface."""
from __future__ import annotations

import os
import typing as t
from . import helpers, json as _json
from .helpers import get_debug_flag
from ..globals import current_app

if t.TYPE_CHECKING:
    from .app import Flask

DEFAULT_PORT = 5000
log_level = "info"


class NoAppException(Exception):
    """Raised if an application cannot be found."""


class ScriptInfo:
    DEFAULT_NAME = "app"

    def __init__(self, app_import_path=None):
        self.app_import_path = app_import_path

    @property
    def data(self):
        def nested():
            pass
        return {}

    class Inner:
        def go(self):
            pass


@click.command("routes")
def routes_command():
    pass


async def serve():
    pass
`;

const TS = `import { readFile } from 'node:fs/promises';
import type { Block } from './blocks';
export { computeBlocks as blocks, applyBlocks } from './blocks';
const path = require('node:path');

export const MAX_TOKENS = 4000;
export const defaultName = 'swage';
const LOCAL_LIMIT = 3;
let counter = 0;

export function estimate(text: string): number {
  return text.length / 4;
}

export const tokenize = (text: string) => text.split(' ');
const helper = function () {};

export interface Budget { max: number }
export type Id = string;
export enum Mode { A, B }

export class Index {
  build(): void {}
  async query(q: string) { return q; }
  private get size() { return 0; }
}

export default class Searcher {}
abstract class Base { abstract run(): void; }
`;

function names(symbols: readonly CodeSymbol[]): string[] {
  return symbols.map((s) => `${s.kind}:${s.container ? s.container + '.' : ''}${s.name}`);
}

let parser: CodeParser;

beforeAll(async () => {
  parser = await createParser();
});

describe('grammarOf', () => {
  it('maps extensions to grammars', () => {
    expect(grammarOf('a.py')).toBe('python');
    expect(grammarOf('a.tsx')).toBe('tsx');
    expect(grammarOf('a.mts')).toBe('typescript');
    expect(grammarOf('a.cjs')).toBe('javascript');
    expect(grammarOf('a.md')).toBeUndefined();
    expect(grammarOf('Makefile')).toBeUndefined();
  });
});

describe('tree-sitter parser', () => {
  it('loads offline from the bundled WASM files', () => {
    expect(parser.engine).toBe('tree-sitter');
  });

  it('extracts Python classes, methods, nested classes, functions and constants', () => {
    const { symbols } = parser.parse(PY, 'python');
    expect(names(symbols)).toEqual([
      'constant:DEFAULT_PORT',
      'class:NoAppException',
      'class:ScriptInfo',
      'constant:ScriptInfo.DEFAULT_NAME',
      'method:ScriptInfo.__init__',
      'method:ScriptInfo.data',
      'class:ScriptInfo.Inner',
      'method:Inner.go',
      'function:routes_command',
      'function:serve',
    ]);
    const routes = symbols.find((s) => s.name === 'routes_command');
    // Decorated definitions start at the decorator.
    expect(routes).toMatchObject({ line: 38, endLine: 40, exported: true });
  });

  it('extracts Python imports, including relative and conditional ones', () => {
    // `from __future__ import ...` is a compiler directive, not a dependency.
    expect(parser.parse(PY, 'python').imports).toEqual([
      'os',
      'typing',
      '.helpers',
      '.json',
      '..globals',
      '.app',
    ]);
  });

  it('extracts TypeScript declarations, methods and export lists', () => {
    const { symbols, imports } = parser.parse(TS, 'typescript');
    expect(names(symbols)).toEqual([
      'export:blocks',
      'export:applyBlocks',
      'constant:MAX_TOKENS',
      'export:defaultName',
      'constant:LOCAL_LIMIT',
      'function:estimate',
      'function:tokenize',
      'function:helper',
      'interface:Budget',
      'type:Id',
      'enum:Mode',
      'class:Index',
      'method:Index.build',
      'method:Index.query',
      'method:Index.size',
      'class:Searcher',
      'class:Base',
      'method:Base.run',
    ]);
    expect(symbols.find((s) => s.name === 'estimate')?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'helper')?.exported).toBe(false);
    expect(imports).toEqual(['node:fs/promises', './blocks', 'node:path']);
  });

  it('parses JavaScript and TSX', () => {
    const js = parser.parse(
      "const api = require('./api');\nfunction load() {}\nmodule.exports = { load };\n",
      'javascript',
    );
    expect(names(js.symbols)).toEqual(['function:load']);
    expect(js.imports).toEqual(['./api']);

    const tsx = parser.parse(
      "import React from 'react';\nexport function TaskList({ tasks }: Props) {\n  return <ul>{tasks.map((t) => <li>{t}</li>)}</ul>;\n}\n",
      'tsx',
    );
    expect(names(tsx.symbols)).toEqual(['function:TaskList']);
    expect(tsx.imports).toEqual(['react']);
  });

  it('survives syntax errors', () => {
    const { symbols } = parser.parse('def ok():\n    pass\n\ndef broken(:\n', 'python');
    expect(symbols.map((s) => s.name)).toContain('ok');
  });

  it('adapts to the change-set SymbolExtractor hook with top-level symbols only', () => {
    const extractor = toSymbolExtractor(parser);
    expect(extractor.extract(PY, 'python').map((d) => `${d.kind}:${d.name}`)).toEqual([
      'export:DEFAULT_PORT',
      'class:NoAppException',
      'class:ScriptInfo',
      'function:routes_command',
      'function:serve',
    ]);
    expect(extractor.extract(TS, 'javascript').length).toBeGreaterThan(0);
  });
});

describe('fallback', () => {
  it('uses the regex parser when the WASM files are missing', async () => {
    let reason = '';
    const p = await createParser({ wasmDir: '/nonexistent', onFallback: (r) => (reason = r) });
    expect(p.engine).toBe('regex');
    expect(reason).toMatch(/missing tree-sitter\.wasm/);
  });

  it('regex parser finds top-level Python symbols and imports', () => {
    const { symbols, imports } = regexParser.parse(PY, 'python');
    expect(symbols.map((s) => s.name)).toEqual([
      'NoAppException',
      'ScriptInfo',
      'routes_command',
      'serve',
    ]);
    expect(imports).toEqual([
      '__future__',
      'os',
      'typing',
      '.helpers',
      '.json',
      '..globals',
      '.app',
    ]);
  });

  it('regex parser finds TypeScript and JavaScript symbols and imports', () => {
    const ts = regexParser.parse(TS, 'tsx');
    expect(ts.symbols.map((s) => s.name)).toContain('Index');
    expect(ts.symbols.find((s) => s.name === 'MAX_TOKENS')?.exported).toBe(true);
    expect(ts.imports).toEqual(['node:fs/promises', './blocks', 'node:path']);
    expect(regexParser.parse("import x from './x';\n", 'javascript').imports).toEqual(['./x']);
  });
});

describe('defaultWasmDir', () => {
  it('finds the npm package by walking up, or the bundled wasm folder', async () => {
    const { defaultWasmDir } = await import('../../../src/context/symbols');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    expect(defaultWasmDir(path.join(process.cwd(), 'src', 'context'))).toBe(
      path.join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
    );

    const dist = realpathSync(mkdtempSync(path.join(tmpdir(), 'swage-dist-')));
    mkdirSync(path.join(dist, 'wasm'));
    writeFileSync(path.join(dist, 'wasm', 'tree-sitter.wasm'), '');
    expect(defaultWasmDir(dist)).toBe(path.join(dist, 'wasm'));
    rmSync(path.join(dist, 'wasm'), { recursive: true });
    expect(defaultWasmDir(dist)).toBe(
      path.join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
    );
    rmSync(dist, { recursive: true, force: true });
  });
});
