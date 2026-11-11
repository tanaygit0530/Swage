import { createHash } from 'node:crypto';

/** Line ending style of a text. `mixed` means both CRLF and lone LF appear. */
export type Eol = 'lf' | 'crlf' | 'mixed' | 'none';

/**
 * Splits text into lines that keep their terminators, so joining them gives the
 * original text byte for byte. A final line without a newline is kept as is.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('');
}

export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function endsWithNewline(text: string): boolean {
  return text.endsWith('\n');
}

/**
 * Makes `next` follow the line-ending style and trailing-newline state of `base`,
 * so a model that writes LF text into a CRLF file, or drops the final newline,
 * does not produce a diff on every line. Mixed-EOL files are left untouched.
 */
export function matchTextStyle(base: string, next: string): string {
  const eol = detectEol(base);
  let out = next;
  if (eol === 'crlf') out = toCrlf(out);
  else if (eol === 'lf') out = toLf(out);

  if (base.length > 0 && out.length > 0) {
    const newline = eol === 'crlf' ? '\r\n' : '\n';
    if (endsWithNewline(base) && !endsWithNewline(out)) {
      out += newline;
    } else if (!endsWithNewline(base) && endsWithNewline(out)) {
      out = out.replace(/\r?\n$/, '');
    }
  }
  return out;
}

/** SHA-256 hex digest of the text's UTF-8 bytes. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
