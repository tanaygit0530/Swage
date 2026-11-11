import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Language, Parser, type Node } from '@vscode/tree-sitter-wasm';
import { regexExtractor, type SymbolExtractor, type SymbolKind } from '../changeset/symbols';

/**
 * Symbol and import extraction for the context engine (blueprint section 7).
 *
 * The primary engine is tree-sitter (`@vscode/tree-sitter-wasm`, MIT: the prebuilt
 * runtime and grammars VS Code itself ships). It runs offline from local WASM files.
 * If the WASM files cannot be loaded, `createParser` falls back to the regex extractor
 * from the change-set module, which finds top-level symbols only.
 */

export type Grammar = 'python' | 'typescript' | 'tsx' | 'javascript';

export type CodeSymbolKind =
  'function' | 'class' | 'method' | 'constant' | 'interface' | 'type' | 'enum' | 'export';

export interface CodeSymbol {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  /** 1-based first line. */
  readonly line: number;
  /** 1-based last line. */
  readonly endLine: number;
  /** Enclosing class, for methods and class constants. */
  readonly container?: string;
  readonly exported: boolean;
}

export interface ParsedFile {
  readonly symbols: readonly CodeSymbol[];
  /** Import specifiers as written, for example `.helpers`, `flask.cli` or `./api`. */
  readonly imports: readonly string[];
}

export interface CodeParser {
  readonly engine: 'tree-sitter' | 'regex';
  parse(text: string, grammar: Grammar): ParsedFile;
}

const GRAMMAR_BY_EXT: Record<string, Grammar> = {
  py: 'python',
  pyi: 'python',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
};

export function grammarOf(filePath: string): Grammar | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filePath)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : GRAMMAR_BY_EXT[ext];
}

const WASM_FILE: Record<Grammar, string> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

/** Grammar WASM files the extension must ship next to `tree-sitter.wasm`. */
export const REQUIRED_WASM_FILES: readonly string[] = [
  'tree-sitter.wasm',
  ...Object.values(WASM_FILE),
];

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

function children(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function nameOf(node: Node | null): string | undefined {
  return node?.childForFieldName('name')?.text;
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

class Collector {
  readonly symbols: CodeSymbol[] = [];
  readonly imports: string[] = [];

  add(
    name: string | undefined,
    kind: CodeSymbolKind,
    node: Node,
    exported: boolean,
    container?: string,
  ): void {
    if (name === undefined || name === '') return;
    this.symbols.push({
      name,
      kind,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported,
      ...(container === undefined ? {} : { container }),
    });
  }

  addImport(spec: string | undefined): void {
    if (spec !== undefined && spec !== '' && !this.imports.includes(spec)) this.imports.push(spec);
  }
}

const PY_COMPOUND = new Set([
  'if_statement',
  'try_statement',
  'with_statement',
  'block',
  'else_clause',
  'elif_clause',
  'except_clause',
  'finally_clause',
]);

function walkPython(node: Node, out: Collector, container: string | undefined): void {
  for (const child of children(node)) {
    const def =
      child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (!def) continue;

    if (def.type === 'class_definition') {
      const name = nameOf(def);
      out.add(name, 'class', child, container === undefined, container);
      const body = def.childForFieldName('body');
      if (body && name !== undefined) walkPython(body, out, name);
    } else if (def.type === 'function_definition') {
      out.add(
        nameOf(def),
        container === undefined ? 'function' : 'method',
        child,
        container === undefined,
        container,
      );
    } else if (def.type === 'expression_statement') {
      const assign = children(def)[0];
      const left = assign?.type === 'assignment' ? assign.childForFieldName('left') : null;
      if (left?.type === 'identifier' && CONSTANT_NAME.test(left.text)) {
        out.add(left.text, 'constant', def, container === undefined, container);
      }
    } else if (def.type === 'import_statement') {
      for (const n of children(def)) {
        out.addImport(n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.text);
      }
    } else if (def.type === 'import_from_statement') {
      const module = def.childForFieldName('module_name')?.text ?? '';
      if (/^\.+$/.test(module)) {
        // `from . import helpers` imports sibling modules.
        for (const n of children(def).slice(1)) {
          const name = n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.text;
          if (name !== undefined) out.addImport(module + name);
        }
      } else {
        out.addImport(module);
      }
    } else if (PY_COMPOUND.has(def.type)) {
      walkPython(def, out, container);
    }
  }
}

function addDeclarators(decl: Node, out: Collector, exported: boolean): void {
  for (const d of children(decl)) {
    if (d.type !== 'variable_declarator') continue;
    const nameNode = d.childForFieldName('name');
    if (nameNode?.type !== 'identifier') continue;
    const value = d.childForFieldName('value');
    const name = nameNode.text;
    if (
      value?.type === 'call_expression' &&
      value.childForFieldName('function')?.text === 'require'
    ) {
      const arg = value.childForFieldName('arguments');
      const first = arg ? children(arg)[0] : undefined;
      if (first?.type === 'string') out.addImport(unquote(first.text));
    }
    if (
      value &&
      /^(arrow_function|function_expression|function|generator_function)$/.test(value.type)
    ) {
      out.add(name, 'function', decl, exported);
    } else if (CONSTANT_NAME.test(name)) {
      out.add(name, 'constant', decl, exported);
    } else if (exported) {
      out.add(name, 'export', decl, exported);
    }
  }
}

function walkClassBody(body: Node, out: Collector, className: string): void {
  for (const member of children(body)) {
    if (member.type === 'method_definition' || member.type === 'abstract_method_signature') {
      out.add(nameOf(member), 'method', member, false, className);
    }
  }
}

function declaration(node: Node, out: Collector, exported: boolean): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      out.add(nameOf(node), 'function', node, exported);
      break;
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      const name = nameOf(node);
      out.add(name, 'class', node, exported);
      const body = node.childForFieldName('body');
      if (body && name !== undefined) walkClassBody(body, out, name);
      break;
    }
    case 'interface_declaration':
      out.add(nameOf(node), 'interface', node, exported);
      break;
    case 'type_alias_declaration':
      out.add(nameOf(node), 'type', node, exported);
      break;
    case 'enum_declaration':
      out.add(nameOf(node), 'enum', node, exported);
      break;
    case 'lexical_declaration':
    case 'variable_declaration':
      addDeclarators(node, out, exported);
      break;
  }
}

function walkScript(root: Node, out: Collector): void {
  for (const child of children(root)) {
    if (child.type === 'import_statement') {
      out.addImport(unquote(child.childForFieldName('source')?.text ?? ''));
    } else if (child.type === 'export_statement') {
      const source = child.childForFieldName('source');
      if (source) out.addImport(unquote(source.text));
      const decl = child.childForFieldName('declaration');
      if (decl) {
        declaration(decl, out, true);
        continue;
      }
      for (const clause of children(child)) {
        if (clause.type !== 'export_clause') continue;
        for (const spec of children(clause)) {
          const alias = spec.childForFieldName('alias')?.text;
          out.add(alias ?? nameOf(spec), 'export', spec, true);
        }
      }
    } else {
      declaration(child, out, false);
    }
  }
}

class TreeSitterParser implements CodeParser {
  readonly engine = 'tree-sitter' as const;
  private readonly parsers = new Map<Grammar, Parser>();

  constructor(languages: ReadonlyMap<Grammar, Language>) {
    for (const [grammar, language] of languages) {
      const p = new Parser();
      p.setLanguage(language);
      this.parsers.set(grammar, p);
    }
  }

  parse(text: string, grammar: Grammar): ParsedFile {
    const parser = this.parsers.get(grammar);
    const tree = parser?.parse(text);
    if (!tree) return regexParser.parse(text, grammar);
    try {
      const out = new Collector();
      if (grammar === 'python') walkPython(tree.rootNode, out, undefined);
      else walkScript(tree.rootNode, out);
      return { symbols: out.symbols, imports: out.imports };
    } finally {
      tree.delete();
    }
  }
}

const REGEX_KIND: Record<SymbolKind, CodeSymbolKind> = {
  function: 'function',
  class: 'class',
  export: 'export',
};

const PY_IMPORT = /^\s*(?:from\s+(\.*[\w.]*)\s+import\s+([\w, ]+)|import\s+([\w.]+))/gm;
const JS_IMPORT =
  /(?:^\s*import\s[^'"]*?from\s*|^\s*import\s*|^\s*export\s[^'"]*?from\s*|\brequire\(\s*)['"]([^'"]+)['"]/gm;

/** Regex fallback: top-level symbols and imports only. */
export const regexParser: CodeParser = {
  engine: 'regex',
  parse(text, grammar) {
    const language =
      grammar === 'python' ? 'python' : grammar === 'javascript' ? 'javascript' : 'typescript';
    const symbols = regexExtractor.extract(text, language).map((d): CodeSymbol => ({
      name: d.name,
      kind: REGEX_KIND[d.kind],
      line: d.line,
      endLine: d.line,
      exported: grammar === 'python' || d.kind === 'export',
    }));
    const imports = new Set<string>();
    if (grammar === 'python') {
      for (const m of text.matchAll(PY_IMPORT)) {
        const [, from, names, plain] = m;
        if (plain !== undefined) imports.add(plain);
        else if (from !== undefined && /^\.+$/.test(from)) {
          for (const n of (names ?? '').split(',')) {
            const name = n.trim().split(/\s+as\s+/)[0] ?? '';
            if (name !== '') imports.add(from + name);
          }
        } else if (from !== undefined) imports.add(from);
      }
    } else {
      for (const m of text.matchAll(JS_IMPORT)) if (m[1] !== undefined) imports.add(m[1]);
    }
    return { symbols, imports: [...imports] };
  },
};

const PACKAGE_WASM = path.join('node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');

/**
 * Finds the WASM folder: `wasm/` next to the bundled extension (`dist/wasm`), or the npm
 * package found by walking up from `start` (development and tests).
 */
export function defaultWasmDir(
  start: string = typeof __dirname === 'string' ? __dirname : process.cwd(),
): string {
  const bundled = path.join(start, 'wasm');
  if (existsSync(path.join(bundled, 'tree-sitter.wasm'))) return bundled;
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, PACKAGE_WASM);
    if (existsSync(path.join(candidate, 'tree-sitter.wasm'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), PACKAGE_WASM);
    dir = parent;
  }
}

let initialized: Promise<void> | undefined;

export interface CreateParserOptions {
  /** Folder holding `tree-sitter.wasm` and the grammar files; the extension passes `dist/wasm`. */
  readonly wasmDir?: string;
  /** Called with the reason when tree-sitter is unavailable and the regex parser is used. */
  readonly onFallback?: (reason: string) => void;
}

/** Loads tree-sitter and the four grammars; falls back to the regex parser on any failure. */
export async function createParser(options: CreateParserOptions = {}): Promise<CodeParser> {
  try {
    const dir = options.wasmDir ?? defaultWasmDir();
    const missing = REQUIRED_WASM_FILES.filter((f) => !existsSync(path.join(dir, f)));
    if (missing.length > 0) throw new Error(`missing ${missing.join(', ')} in ${dir}`);
    initialized ??= Parser.init({ locateFile: (file: string) => path.join(dir, file) });
    await initialized;
    const languages = new Map<Grammar, Language>();
    for (const [grammar, file] of Object.entries(WASM_FILE) as [Grammar, string][]) {
      languages.set(grammar, await Language.load(path.join(dir, file)));
    }
    return new TreeSitterParser(languages);
  } catch (err) {
    options.onFallback?.((err as Error).message);
    return regexParser;
  }
}

/** Adapts a parser to the change-set `SymbolExtractor` hook (top-level symbols only). */
export function toSymbolExtractor(parser: CodeParser): SymbolExtractor {
  return {
    extract(text, language) {
      const grammar: Grammar = language === 'python' ? 'python' : language;
      return parser
        .parse(text, grammar)
        .symbols.filter((s) => s.container === undefined)
        .map((s) => ({
          name: s.name,
          kind: s.kind === 'function' || s.kind === 'class' ? s.kind : 'export',
          line: s.line,
        }));
    },
  };
}
