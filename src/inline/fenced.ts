import { splitLines } from '../changeset/text';
import type { LineRange } from './context';

/**
 * Fenced-code fallback (blueprint section 3, G21): when a weak model answers an inline edit with
 * a code block instead of a stage_edit call, the block replaces the selection and goes through
 * the same review, so the user still gets a per-block diff instead of a chat reply to copy.
 */

const FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

/** The largest fenced code block in a reply, without its fences, or undefined if there is none. */
export function extractFencedCode(reply: string): string | undefined {
  let best: string | undefined;
  for (const m of reply.matchAll(FENCE)) {
    const body = m[3] ?? '';
    if (best === undefined || body.length > best.length) best = body;
  }
  return best;
}

/**
 * The file with lines `startLine..endLine` replaced by `code`, keeping the file's line endings
 * and the newline after the range.
 */
export function replaceRange(text: string, range: LineRange, code: string): string {
  const lines = splitLines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const first = Math.max(0, range.startLine - 1);
  const last = Math.min(lines.length, range.endLine);
  const replaced = lines.slice(first, last).join('');
  const trailing = /\r?\n$/.test(replaced) || last < lines.length ? eol : '';
  const body = code.replace(/\r?\n$/, '').replace(/\r?\n/g, eol);
  return [...lines.slice(0, first), body === '' ? '' : body + trailing, ...lines.slice(last)].join(
    '',
  );
}
