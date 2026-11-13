/**
 * A small, safe Markdown parser for assistant text (redesign step 2). It produces a tree that
 * the panel renders as Preact elements, so raw HTML in the model's text is never interpreted:
 * `<script>` stays the literal text "<script>". Supported: ATX headings, paragraphs, bold,
 * italic, inline code, http(s) and mailto links, ordered and unordered lists (nested by
 * indentation), fenced code blocks (also while still streaming), tables, block quotes and rules.
 * File paths and `name()` symbols become mention chips.
 */

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'link'; readonly href: string; readonly c: readonly Inline[] }
  | { readonly t: 'path'; readonly path: string; readonly line?: number }
  | { readonly t: 'symbol'; readonly name: string };

export type Block =
  | { readonly t: 'h'; readonly level: number; readonly c: readonly Inline[] }
  | { readonly t: 'p'; readonly c: readonly Inline[] }
  | {
      readonly t: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
    }
  | { readonly t: 'code'; readonly lang: string; readonly v: string; readonly open: boolean }
  | {
      readonly t: 'table';
      readonly head: readonly (readonly Inline[])[];
      readonly align: readonly ('left' | 'center' | 'right' | undefined)[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly t: 'quote'; readonly c: readonly Block[] }
  | { readonly t: 'hr' };

const EXTENSIONS =
  'py|pyi|ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|rst|txt|toml|yaml|yml|cfg|ini|html|htm|css|scss|less|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|sql|xml|vue|svelte|lock|env|gradle|swift|dart|lua';

/** A workspace-style path with a known extension, optionally followed by `:line`. */
const PATH = new RegExp(
  `(^|[^\\w/.@-])((?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXTENSIONS}))(?::(\\d+))?(?![\\w/])`,
  'g',
);

const SYMBOL = /^[A-Za-z_][\w.]*\(\)$/;

/** Splits plain text into text and path chips. */
export function linkPaths(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH)) {
    const lead = m[1] ?? '';
    const path = m[2] ?? '';
    const at = (m.index ?? 0) + lead.length;
    // A URL's host or path is not a workspace file.
    if (/[a-z]+:\/\/\S*$/i.test(text.slice(0, at))) continue;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    const line = m[3] === undefined ? undefined : Number(m[3]);
    out.push(line === undefined ? { t: 'path', path } : { t: 'path', path, line });
    last = at + path.length + (m[3] === undefined ? 0 : m[3].length + 1);
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : undefined;
}

/** Parses inline Markdown. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push(...linkPaths(text));
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    const rest = src.slice(i);
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!|>]/.test(src[i + 1] ?? '')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(rest)?.[0] ?? '`';
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        const v = src.slice(i + ticks.length, end).replace(/^ (.*) $/, '$1');
        const path = linkPaths(v);
        const only = path.length === 1 ? path[0] : undefined;
        if (only?.t === 'path') out.push(only);
        else if (SYMBOL.test(v)) out.push({ t: 'symbol', name: v.slice(0, -2) });
        else out.push({ t: 'code', v });
        i = end + ticks.length;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]*)\]\(([^()\s]+)\)/.exec(rest);
      if (m) {
        const href = safeHref(m[2] ?? '');
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(m[1] ?? '') });
        else out.push(...parseInline(m[1] ?? ''));
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const strong = new RegExp(`^\\${ch}\\${ch}(?=\\S)([\\s\\S]*?\\S)\\${ch}\\${ch}`).exec(rest);
      if (strong) {
        flush();
        out.push({ t: 'strong', c: parseInline(strong[1] ?? '') });
        i += strong[0].length;
        continue;
      }
      const prev = src[i - 1] ?? ' ';
      // `_` inside a word (snake_case) is not emphasis.
      if (ch === '*' || !/\w/.test(prev)) {
        const em = new RegExp(
          `^\\${ch}(?=[^\\s${ch}])([^${ch}\\n]*?[^\\s${ch}])\\${ch}(?!\\w)`,
        ).exec(rest);
        if (em && (ch === '*' || !/\w/.test(src[i + em[0].length] ?? ' '))) {
          flush();
          out.push({ t: 'em', c: parseInline(em[1] ?? '') });
          i += em[0].length;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( *)([-*+])\s+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    /^ {0,3}>/.test(line)
  );
}

/** Parses Markdown into blocks. An unclosed fence (text still streaming) is an open code block. */
export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(l)) {
          open = false;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n'), open });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1]?.length ?? 1, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^ {0,3}> ?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseLines(body) });
      continue;
    }
    const list = BULLET.exec(line) ?? ORDERED.exec(line);
    if (list) {
      const ordered = ORDERED.test(line) && !BULLET.test(line);
      const indent = list[1]?.length ?? 0;
      const items: Block[][] = [];
      const start = ordered ? Number(list[2]) : 1;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ordered ? ORDERED.exec(l) : BULLET.exec(l);
        if (!m || (m[1]?.length ?? 0) !== indent) break;
        const body = [m[3] ?? ''];
        i++;
        // Continuation: indented lines (nested lists, wrapped text) and single blank lines.
        while (i < lines.length) {
          const next = lines[i] ?? '';
          if (next.trim() === '') {
            const after = lines[i + 1] ?? '';
            if (/^\s+\S/.test(after) && after.length - after.trimStart().length > indent) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          const lead = next.length - next.trimStart().length;
          if (lead > indent) {
            body.push(next.slice(Math.min(lead, indent + 2)));
            i++;
            continue;
          }
          if (!isBlockStart(next) && lead === indent && !TABLE_SEP.test(next)) {
            // A lazy continuation of the item's paragraph.
            body.push(next.trim());
            i++;
            continue;
          }
          break;
        }
        items.push(parseLines(body));
      }
      blocks.push({ t: 'list', ordered, start, items });
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const align = cells(lines[i + 1] ?? '').map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : undefined,
      );
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        const r = cells(lines[i] ?? '');
        rows.push(head.map((_, k) => parseInline(r[k] ?? '')));
        i++;
      }
      blocks.push({ t: 'table', head: head.map(parseInline), align, rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '' || isBlockStart(l)) break;
      if (l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}
