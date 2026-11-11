/**
 * Light symbol check (blueprint section 2, guardrails): warn when an edit deletes a
 * top-level function, class or export that files in the change set still reference.
 *
 * Extraction uses regexes for Python, TypeScript and JavaScript. A tree-sitter based
 * extractor can replace it later through the `SymbolExtractor` interface.
 */

export type Language = 'python' | 'typescript' | 'javascript';
export type SymbolKind = 'function' | 'class' | 'export';

export interface SymbolDef {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based line of the definition. */
  readonly line: number;
}

/** Hook for a smarter extractor (for example web-tree-sitter) later. */
export interface SymbolExtractor {
  extract(text: string, language: Language): SymbolDef[];
}

export interface FileSnapshot {
  readonly path: string;
  /** Content before the change set; `undefined` for a created file. */
  readonly before: string | undefined;
  /** Content after the change set; `undefined` for a deleted file. */
  readonly after: string | undefined;
}

export interface SymbolReference {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SymbolWarning {
  readonly symbol: string;
  readonly kind: SymbolKind;
  readonly definedIn: string;
  readonly references: readonly SymbolReference[];
  readonly message: string;
}

const EXTENSIONS: Record<string, Language> = {
  py: 'python',
  pyi: 'python',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
};

export function languageOf(path: string): Language | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : EXTENSIONS[ext];
}

type Rule = readonly [RegExp, SymbolKind];

const PYTHON_RULES: readonly Rule[] = [
  [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
  [/^class\s+([A-Za-z_]\w*)/, 'class'],
];

const SCRIPT_RULES: readonly Rule[] = [
  [
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    'function',
  ],
  [/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^export\s+(?:declare\s+)?(?:const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'export'],
  [/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    'function',
  ],
];

/** Names exported through `export { a, b as c }`; the exported name is what others import. */
function exportListNames(line: string): string[] {
  const body = /^export\s+(?:type\s+)?\{([^}]*)\}/.exec(line)?.[1];
  if (body === undefined) return [];
  return body
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter((part) => part.length > 0)
    .map(
      (part) =>
        part
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? part,
    )
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default');
}

export const regexExtractor: SymbolExtractor = {
  extract(text, language) {
    const rules = language === 'python' ? PYTHON_RULES : SCRIPT_RULES;
    const seen = new Set<string>();
    const defs: SymbolDef[] = [];
    const add = (name: string, kind: SymbolKind, line: number): void => {
      if (seen.has(name)) return;
      seen.add(name);
      defs.push({ name, kind, line });
    };

    text.split(/\r?\n/).forEach((raw, i) => {
      // Top level only: definitions must start in column 0.
      for (const [re, kind] of rules) {
        const name = re.exec(raw)?.[1];
        if (name !== undefined) {
          add(name, kind, i + 1);
          return;
        }
      }
      if (language !== 'python') {
        for (const name of exportListNames(raw)) add(name, 'export', i + 1);
      }
    });
    return defs;
  },
};

function isCommentLine(line: string, language: Language | undefined): boolean {
  const t = line.trimStart();
  if (language === 'python') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findReferences(
  file: FileSnapshot,
  name: string,
  ownDefLines: ReadonlySet<number>,
): SymbolReference[] {
  if (file.after === undefined) return [];
  const language = languageOf(file.path);
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  const refs: SymbolReference[] = [];
  file.after.split(/\r?\n/).forEach((line, i) => {
    if (ownDefLines.has(i + 1) || isCommentLine(line, language)) return;
    if (word.test(line)) refs.push({ path: file.path, line: i + 1, text: line.trim() });
  });
  return refs;
}

export interface SymbolCheckOptions {
  readonly extractor?: SymbolExtractor;
  /** Maximum references listed per warning. */
  readonly maxReferences?: number;
}

/**
 * Returns a warning for every top-level symbol that a file in the change set removed
 * while the change set's resulting files (including the same file) still mention it.
 */
export function checkDeletedSymbols(
  files: readonly FileSnapshot[],
  options: SymbolCheckOptions = {},
): SymbolWarning[] {
  const extractor = options.extractor ?? regexExtractor;
  const maxReferences = options.maxReferences ?? 5;
  const warnings: SymbolWarning[] = [];

  const defsAfter = new Map<string, SymbolDef[]>();
  for (const f of files) {
    const lang = languageOf(f.path);
    defsAfter.set(f.path, lang && f.after !== undefined ? extractor.extract(f.after, lang) : []);
  }

  for (const file of files) {
    const lang = languageOf(file.path);
    if (!lang || file.before === undefined) continue;
    const after = new Set((defsAfter.get(file.path) ?? []).map((d) => d.name));
    const removed = extractor.extract(file.before, lang).filter((d) => !after.has(d.name));

    for (const def of removed) {
      const references: SymbolReference[] = [];
      for (const other of files) {
        const ownDefs = new Set(
          (defsAfter.get(other.path) ?? []).filter((d) => d.name === def.name).map((d) => d.line),
        );
        references.push(...findReferences(other, def.name, ownDefs));
      }
      if (references.length === 0) continue;
      const where = [...new Set(references.map((r) => r.path))].join(', ');
      warnings.push({
        symbol: def.name,
        kind: def.kind,
        definedIn: file.path,
        references: references.slice(0, maxReferences),
        message: `${def.kind} ${def.name} was removed from ${file.path} but is still referenced in ${where}. Restore it, or update every reference in the same change set.`,
      });
    }
  }
  return warnings;
}
