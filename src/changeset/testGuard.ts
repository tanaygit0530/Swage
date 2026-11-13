/**
 * Existing tests an edit would lose (found in the Task B rehearsal: the agent put its new test
 * inside `class TestRoutes`, which cut one test short and nested the class's other methods in
 * the new function, so pytest stopped collecting them while the run still "passed").
 *
 * Lexical and conservative: Python module-level `test_*` functions and methods of `Test*`
 * classes, as pytest collects them; JavaScript and TypeScript `it(...)` and `test(...)` titles.
 * Other files are not checked.
 */

const PY_TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const JS_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return PY_TEST_FILE.test(path) || JS_TEST_FILE.test(path);
}

/** The tests a file defines, as collected, or undefined for files that are not test files. */
export function collectedTests(path: string, text: string): string[] | undefined {
  if (PY_TEST_FILE.test(path)) return pythonTests(text);
  if (JS_TEST_FILE.test(path)) return jsTests(text);
  return undefined;
}

function pythonTests(text: string): string[] {
  const out: string[] = [];
  let testClass: string | undefined;
  let classIndent = -1;
  let methodIndent: number | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const cls = /^class\s+(\w+)/.exec(line);
    if (indent === 0) {
      testClass = cls && cls[1]?.startsWith('Test') ? cls[1] : undefined;
      classIndent = testClass ? 0 : -1;
      methodIndent = undefined;
      const fn = /^(?:async\s+)?def\s+(test\w*)/.exec(line);
      if (fn?.[1]) out.push(fn[1]);
      continue;
    }
    if (!testClass || indent <= classIndent) continue;
    const m = /^\s+(?:async\s+)?def\s+(test\w*)/.exec(line);
    // Methods sit at the class body's indentation; deeper defs are nested helpers.
    if (/^\s+(?:async\s+)?def\s/.test(line) && methodIndent === undefined) methodIndent = indent;
    if (m?.[1] && indent === methodIndent) out.push(`${testClass}.${m[1]}`);
  }
  return out;
}

function jsTests(text: string): string[] {
  return [
    ...text.matchAll(/\b(?:it|test)(?:\.(?:only|skip|each\([^)]*\)))?\(\s*(['"`])(.+?)\1/g),
  ].map((m) => m[2] ?? '');
}

/** Tests in `before` that `after` no longer collects (renamed, deleted, nested or cut). */
export function lostTests(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string[] {
  if (before === undefined) return [];
  const was = collectedTests(path, before);
  if (!was) return [];
  const now = new Set(after === undefined ? [] : (collectedTests(path, after) ?? []));
  return was.filter((t) => !now.has(t));
}
