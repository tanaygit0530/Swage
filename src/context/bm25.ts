import * as path from 'node:path';
import type { FileRecord, WorkspaceIndex } from './indexer';
import type { CodeSymbol } from './symbols';
import { splitIdentifier, stem, STOP_WORDS, tokenize } from './tokens';

/**
 * Lexical retrieval (blueprint section 7): BM25 over identifier tokens in three fields
 * (content, symbol names, path), boosted by exact symbol matches, files one import hop
 * from the top hits, and paired test files. Every score comes with human-readable
 * reasons for the Context Receipt.
 */

export interface Bm25Weights {
  readonly content: number;
  readonly symbols: number;
  readonly path: number;
  /** Added when the query names a symbol exactly, for example `get_debug_flag`. */
  readonly exactSymbol: number;
  /** Share of a top hit's score given to files it imports or that import it. */
  readonly importHop: number;
  /** Share of a source hit's score given to its paired test file. */
  readonly pairedTest: number;
  /** Share of a source hit's score given to a docs page with the same name, such as docs/cli.md. */
  readonly pairedDoc: number;
  /** Multiplier for the active editor file. */
  readonly activeFile: number;
}

export const DEFAULT_WEIGHTS: Bm25Weights = {
  content: 1,
  symbols: 2,
  path: 2.5,
  exactSymbol: 6,
  importHop: 0.3,
  pairedTest: 0.5,
  pairedDoc: 0.5,
  activeFile: 1.2,
};

export interface SearchOptions {
  readonly limit?: number;
  /** Workspace-relative path of the active editor file. */
  readonly activeFile?: string;
  /** How many top hits spread import-graph boosts. */
  readonly hopFrom?: number;
  /** How many top hits spread paired-test and paired-docs boosts. */
  readonly pairFrom?: number;
}

export interface SearchHit {
  readonly path: string;
  readonly score: number;
  /** Why the file was chosen, most important first. */
  readonly reasons: readonly string[];
  /** Symbols whose names match the query. */
  readonly symbols: readonly string[];
  /** Line range of the best-matching symbol, if any. */
  readonly lines?: { readonly start: number; readonly end: number };
  readonly estimatedTokens: number;
}

interface Field {
  readonly tf: Map<string, Map<string, number>>;
  readonly length: Map<string, number>;
  readonly df: Map<string, number>;
  avgdl: number;
}

function emptyField(): Field {
  return { tf: new Map(), length: new Map(), df: new Map(), avgdl: 0 };
}

function addDoc(field: Field, doc: string, tf: ReadonlyMap<string, number>): void {
  let len = 0;
  for (const [term, n] of tf) {
    len += n;
    let postings = field.tf.get(term);
    if (!postings) {
      postings = new Map();
      field.tf.set(term, postings);
    }
    postings.set(doc, n);
    field.df.set(term, (field.df.get(term) ?? 0) + 1);
  }
  field.length.set(doc, len);
}

function counts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Path tokens without the file extension, so `package.json` does not match "json". */
function pathTokens(p: string): string[] {
  return splitIdentifier(p.replace(/\.[A-Za-z0-9]+$/, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

function symbolTokens(symbols: readonly CodeSymbol[]): string[] {
  return symbols.flatMap((s) => tokenize(s.name));
}

/** `tests/test_cli.py` and `src/x.test.ts` style names map to the source stem they cover. */
export function testedStem(p: string): string | undefined {
  const base = path.posix.basename(p);
  const m =
    /^test_(.+)\.py$/.exec(base) ??
    /^(.+)_test\.py$/.exec(base) ??
    /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(base);
  return m?.[1];
}

const DOC_FILE = /(^|\/)(docs?|documentation)\/(?:.+\/)?([^/]+)\.(?:md|rst|txt|adoc)$/i;

/** `docs/cli.rst` documents the `cli` module. */
export function documentedStem(p: string): string | undefined {
  return DOC_FILE.exec(p)?.[3]?.toLowerCase();
}

/**
 * A paired test or docs page gains a share of its source's score but does not overtake
 * the source through the bonus alone.
 */
function pairedScore(own: number, source: number, weight: number): number {
  return Math.max(own, Math.min(own + weight * source, source * 0.99));
}

function isTestFile(p: string): boolean {
  return testedStem(p) !== undefined || /(^|\/)(tests?|__tests__)\//.test(p);
}

function sourceStem(p: string): string {
  return path.posix.basename(p).replace(/\.[^.]+$/, '');
}

export class Bm25Searcher {
  private readonly weights: Bm25Weights;
  private readonly k1: number;
  private readonly b: number;
  private stale = true;
  private docs = new Map<string, FileRecord>();
  private content = emptyField();
  private symbolField = emptyField();
  private pathField = emptyField();
  private symbolsByName = new Map<string, string[]>();
  private testsByStem = new Map<string, string[]>();
  private docsByStem = new Map<string, string[]>();
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly index: WorkspaceIndex,
    options: { weights?: Partial<Bm25Weights>; k1?: number; b?: number } = {},
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.subscription = index.onDidUpdate(() => {
      this.stale = true;
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private rebuild(): void {
    this.docs = new Map(this.index.files().map((f) => [f.path, f]));
    this.content = emptyField();
    this.symbolField = emptyField();
    this.pathField = emptyField();
    this.symbolsByName = new Map();
    this.testsByStem = new Map();
    this.docsByStem = new Map();

    for (const rec of this.docs.values()) {
      addDoc(this.content, rec.path, new Map(Object.entries(rec.tokens)));
      addDoc(this.symbolField, rec.path, counts(symbolTokens(rec.symbols)));
      addDoc(this.pathField, rec.path, counts(pathTokens(rec.path)));
      for (const s of rec.symbols) {
        const key = s.name.toLowerCase();
        this.symbolsByName.set(key, [...(this.symbolsByName.get(key) ?? []), rec.path]);
      }
      const tested = testedStem(rec.path);
      if (tested !== undefined)
        this.testsByStem.set(tested, [...(this.testsByStem.get(tested) ?? []), rec.path]);
      const documented = documentedStem(rec.path);
      if (documented !== undefined)
        this.docsByStem.set(documented, [...(this.docsByStem.get(documented) ?? []), rec.path]);
    }
    for (const field of [this.content, this.symbolField, this.pathField]) {
      let total = 0;
      for (const n of field.length.values()) total += n;
      field.avgdl = field.length.size === 0 ? 0 : total / field.length.size;
    }
    this.stale = false;
  }

  private fieldScore(field: Field, doc: string, terms: readonly string[]): number {
    const n = this.docs.size;
    const len = field.length.get(doc) ?? 0;
    if (len === 0 || field.avgdl === 0) return 0;
    let score = 0;
    for (const term of terms) {
      const f = field.tf.get(term)?.get(doc) ?? 0;
      if (f === 0) continue;
      const df = field.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score +=
        (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * len) / field.avgdl));
    }
    return score;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    if (this.stale) this.rebuild();
    const limit = options.limit ?? 10;
    const hopFrom = options.hopFrom ?? 5;
    const pairFrom = options.pairFrom ?? 10;
    const terms = [...new Set(tokenize(query))];
    const identifiers = new Set(
      (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        .filter((w) => /[_A-Z]/.test(w.slice(1)) || w.includes('_'))
        .map((w) => w.toLowerCase()),
    );
    if (terms.length === 0 && identifiers.size === 0) return [];

    const candidates = new Set<string>();
    for (const term of terms) {
      for (const field of [this.content, this.symbolField, this.pathField]) {
        for (const doc of field.tf.get(term)?.keys() ?? []) candidates.add(doc);
      }
    }
    for (const id of identifiers)
      for (const doc of this.symbolsByName.get(id) ?? []) candidates.add(doc);

    const scores = new Map<string, number>();
    const reasons = new Map<string, string[]>();
    const matched = new Map<string, CodeSymbol[]>();
    const addReason = (doc: string, reason: string, first = false): void => {
      const list = reasons.get(doc) ?? [];
      if (!list.includes(reason)) {
        if (first) list.unshift(reason);
        else list.push(reason);
      }
      reasons.set(doc, list);
    };

    for (const doc of candidates) {
      const rec = this.docs.get(doc);
      if (!rec) continue;
      const c = this.fieldScore(this.content, doc, terms);
      const s = this.fieldScore(this.symbolField, doc, terms);
      const p = this.fieldScore(this.pathField, doc, terms);
      let score = this.weights.content * c + this.weights.symbols * s + this.weights.path * p;

      const hitSymbols = rec.symbols.filter((sym) => {
        const st = tokenize(sym.name);
        return (
          identifiers.has(sym.name.toLowerCase()) ||
          (st.length > 0 && st.some((t) => terms.includes(t)))
        );
      });
      const exact = rec.symbols.filter((sym) => identifiers.has(sym.name.toLowerCase()));
      if (exact.length > 0) {
        score += this.weights.exactSymbol;
        addReason(doc, `defines \`${exact[0]?.name ?? ''}\``);
      } else if (hitSymbols.length > 0 && s > 0) {
        const names = hitSymbols.slice(0, 2).map((x) => `\`${x.name}\``);
        addReason(doc, `defines ${names.join(', ')}`);
      }
      if (p > 0) {
        const pt = new Set(pathTokens(doc));
        addReason(doc, `path matches ${terms.filter((t) => pt.has(t)).join(', ')}`);
      }
      if (c > 0) {
        const present = terms.filter((t) => (rec.tokens[t] ?? 0) > 0);
        const top = present
          .sort((a, b) => (this.content.df.get(a) ?? 0) - (this.content.df.get(b) ?? 0))
          .slice(0, 3);
        addReason(doc, `mentions ${top.join(', ')}`);
        // Files that cover more of the query rank higher.
        score *= 0.5 + (0.5 * present.length) / Math.max(1, terms.length);
      }
      if (options.activeFile !== undefined && doc === options.activeFile) {
        score *= this.weights.activeFile;
        addReason(doc, 'active file', true);
      }
      if (score > 0) {
        scores.set(doc, score);
        matched.set(doc, exact.length > 0 ? exact : hitSymbols);
      }
    }

    // One hop in the import graph and paired tests, spread from the top hits only.
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const base = ranked.slice(0, Math.max(hopFrom, pairFrom));
    const graph = this.index.importGraph();
    for (const [rank, [doc, score]] of base.entries()) {
      const neighbours = new Map<string, string>();
      if (rank < hopFrom) {
        for (const n of graph.forward.get(doc) ?? []) neighbours.set(n, `imported by ${doc}`);
        for (const n of graph.reverse.get(doc) ?? [])
          if (!neighbours.has(n)) neighbours.set(n, `imports ${doc}`);
        for (const [n, why] of neighbours) {
          if (!this.docs.has(n)) continue;
          const own = scores.get(n) ?? 0;
          scores.set(n, own + this.weights.importHop * score * (own > 0 ? 1 : 0.5));
          addReason(n, why);
        }
      }
      if (rank < pairFrom && !isTestFile(doc) && documentedStem(doc) === undefined) {
        const stemName = sourceStem(doc);
        for (const t of this.testsByStem.get(stemName) ?? []) {
          if (t === doc) continue;
          scores.set(t, pairedScore(scores.get(t) ?? 0, score, this.weights.pairedTest));
          addReason(t, `paired test for ${doc}`, true);
        }
        for (const d of this.docsByStem.get(stemName.toLowerCase()) ?? []) {
          scores.set(d, pairedScore(scores.get(d) ?? 0, score, this.weights.pairedDoc));
          addReason(d, `documents ${doc}`, true);
        }
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([doc, score]) => {
        const rec = this.docs.get(doc);
        const syms = matched.get(doc) ?? [];
        const best = syms[0];
        return {
          path: doc,
          score: Math.round(score * 1000) / 1000,
          reasons: reasons.get(doc) ?? [],
          symbols: syms.map((x) => x.name),
          ...(best ? { lines: { start: best.line, end: best.endLine } } : {}),
          estimatedTokens: rec?.estimatedTokens ?? 0,
        };
      });
  }
}
