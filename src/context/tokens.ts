/**
 * Identifier-aware tokens for lexical retrieval (blueprint section 7). Splits snake_case,
 * camelCase, kebab-case and dotted names, lowercases, drops stop words and applies a tiny
 * suffix stemmer so `routes`, `route` and `routing` meet. Deterministic and model-free.
 */

/** English filler, common task verbs and language keywords that carry no signal. */
// prettier-ignore
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'into', 'onto', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'their', 'they', 'we', 'you', 'your',
  'our', 'he', 'she', 'his', 'her', 'them', 'so', 'not', 'no', 'yes', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have',
  'had', 'any', 'all', 'each', 'every', 'some', 'such', 'than', 'too', 'very', 'also', 'only',
  'just', 'when', 'where', 'which', 'who', 'whom', 'what', 'why', 'how', 'about', 'after',
  'before', 'over', 'under', 'again', 'other', 'same', 'own', 'out', 'up', 'down', 'off',
  'via', 'per', 'eg', 'ie', 'etc', 'like', 'one', 'two', 'way', 'ensure', 'make', 'sure',
  'please', 'add', 'adds', 'added', 'new', 'use', 'used', 'using', 'need', 'needs', 'want',
  'let', 'lets', 'get', 'set', 'well', 'still', 'instead',
  // Keywords that appear in almost every file. `import` and `export` stay searchable
  // because they are also everyday task words ("export tasks as CSV").
  'def', 'class', 'self', 'cls', 'return', 'returns', 'const', 'var', 'function',
  'while', 'elif', 'none', 'null', 'undefined', 'true', 'false', 'try', 'except', 'finally',
  'raise', 'throw', 'throws', 'catch', 'pass', 'lambda', 'yield', 'async', 'await',
  'public', 'private', 'protected', 'static', 'readonly', 'void', 'str', 'int', 'bool', 'float',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never', 'typeof', 'instanceof',
  'require', 'module', 'exports', 'args', 'kwargs', 'init', 'todo', 'fixme', 'noqa', 'param',
  'params', 'rtype', 'py', 'ts', 'js', 'tsx', 'jsx',
]);

/** Splits one identifier into lowercase parts: `getDebugFlag` -> get, debug, flag. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0);
}

/** `logg` -> `log`, `mapp` -> `map`: a doubled final consonant left by `-ing` or `-ed`. */
function undouble(w: string): string {
  return /([^aeiouslz])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** A tiny suffix stemmer; the same rule runs on queries and documents, so it only has to be consistent. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2));
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us'))
    w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function keep(part: string): boolean {
  return part.length >= 2 && !/^\d+$/.test(part) && !STOP_WORDS.has(part);
}

/** Words that are syntax in code files but meaningful in prose ("export tasks"). */
export const CODE_ONLY_KEYWORDS: ReadonlySet<string> = new Set(['import', 'export']);

/**
 * Tokens of free text or code, in order, with duplicates. `skipWords` drops whole words
 * (not identifier parts), so `export` the keyword goes but `export_json` still yields `export`.
 */
export function tokenize(text: string, skipWords?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    if (skipWords?.has(word)) continue;
    for (const part of splitIdentifier(word)) {
      if (keep(part)) out.push(stem(part));
    }
  }
  return out;
}

/** Term frequencies of `tokenize(text, skipWords)`. */
export function termFrequencies(
  text: string,
  skipWords?: ReadonlySet<string>,
): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokenize(text, skipWords)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Crude, model-independent token estimate: characters divided by 4 (blueprint section 7). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
