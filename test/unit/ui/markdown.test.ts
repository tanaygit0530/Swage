import { describe, expect, it } from 'vitest';
import { linkPaths, parseInline, parseMarkdown } from '../../../src/ui/webview/markdown';

describe('Markdown parser', () => {
  it('parses headings, paragraphs, bold, italic, inline code and links', () => {
    const blocks = parseMarkdown(
      '## Created Files\n\nThis is **bold**, *em*, `x = 1` and [docs](https://flask.palletsprojects.com).',
    );
    expect(blocks[0]).toEqual({ t: 'h', level: 2, c: [{ t: 'text', v: 'Created Files' }] });
    expect(blocks[1]).toEqual({
      t: 'p',
      c: [
        { t: 'text', v: 'This is ' },
        { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
        { t: 'text', v: ', ' },
        { t: 'em', c: [{ t: 'text', v: 'em' }] },
        { t: 'text', v: ', ' },
        { t: 'code', v: 'x = 1' },
        { t: 'text', v: ' and ' },
        {
          t: 'link',
          href: 'https://flask.palletsprojects.com',
          c: [{ t: 'text', v: 'docs' }],
        },
        { t: 'text', v: '.' },
      ],
    });
  });

  it('never makes a link of a javascript: or relative URL', () => {
    const [p] = parseMarkdown('[click](javascript:alert(1)) [rel](foo)');
    expect(JSON.stringify(p)).not.toContain('"link"');
  });

  it('keeps raw HTML as text', () => {
    const [p] = parseMarkdown('<script>alert(1)</script> <img src=x onerror=y>');
    expect(p).toEqual({
      t: 'p',
      c: [{ t: 'text', v: '<script>alert(1)</script> <img src=x onerror=y>' }],
    });
  });

  it('parses ordered and unordered lists, nested by indentation', () => {
    const [ol, ul] = parseMarkdown(
      '1. packages/database/requirements.txt - SQLAlchemy\n2. apps/bot/requirements.txt\n   - aiogram\n   - redis\n\n- one\n- two',
    );
    expect(ol).toMatchObject({ t: 'list', ordered: true, start: 1 });
    if (ol?.t !== 'list') throw new Error('not a list');
    expect(ol.items).toHaveLength(2);
    expect(ol.items[0]?.[0]).toMatchObject({
      t: 'p',
      c: [
        { t: 'path', path: 'packages/database/requirements.txt' },
        { t: 'text', v: ' - SQLAlchemy' },
      ],
    });
    expect(ol.items[1]?.[1]).toMatchObject({ t: 'list', ordered: false });
    expect(ul).toMatchObject({ t: 'list', ordered: false });
  });

  it('parses fenced code blocks, and an unclosed fence while streaming', () => {
    const done = parseMarkdown('```bash\ncd apps/api\npip install -r requirements.txt\n```\nafter');
    expect(done[0]).toEqual({
      t: 'code',
      lang: 'bash',
      v: 'cd apps/api\npip install -r requirements.txt',
      open: false,
    });
    expect(done[1]).toMatchObject({ t: 'p' });
    expect(parseMarkdown('```py\nprint(1)')[0]).toEqual({
      t: 'code',
      lang: 'py',
      v: 'print(1)',
      open: true,
    });
  });

  it('parses tables with alignment', () => {
    const [table] = parseMarkdown('| File | +/- |\n|:--|--:|\n| cli.py | +12 |\n| a \\| b | 3 |');
    expect(table).toMatchObject({ t: 'table', align: ['left', 'right'] });
    if (table?.t !== 'table') throw new Error('not a table');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.[0]).toEqual([{ t: 'path', path: 'cli.py' }]);
    expect(table.rows[1]?.[0]).toEqual([{ t: 'text', v: 'a | b' }]);
  });

  it('parses block quotes and rules', () => {
    expect(parseMarkdown('> note\n\n---')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'note' }] }] },
      { t: 'hr' },
    ]);
  });

  it('turns file paths and name() symbols into chips', () => {
    expect(linkPaths('see src/flask/cli.py:42 and README.md.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'path', path: 'src/flask/cli.py', line: 42 },
      { t: 'text', v: ' and ' },
      { t: 'path', path: 'README.md' },
      { t: 'text', v: '.' },
    ]);
    expect(parseInline('`get_debug_flag()` and `src/app.ts`')).toEqual([
      { t: 'symbol', name: 'get_debug_flag' },
      { t: 'text', v: ' and ' },
      { t: 'path', path: 'src/app.ts' },
    ]);
  });

  it('leaves URLs, versions and snake_case alone', () => {
    expect(linkPaths('https://example.com/a/b.py and 3.1.3')).toEqual([
      { t: 'text', v: 'https://example.com/a/b.py and 3.1.3' },
    ]);
    expect(parseInline('FLASK_DEBUG and snake_case_name')).toEqual([
      { t: 'text', v: 'FLASK_DEBUG and snake_case_name' },
    ]);
  });

  it('handles escapes and double-backtick code', () => {
    expect(parseInline('\\*not em\\* ``a `b` c``')).toEqual([
      { t: 'text', v: '*not em* ' },
      { t: 'code', v: 'a `b` c' },
    ]);
  });
});

describe('Markdown parser: edge cases', () => {
  it('keeps a list item together across a blank line before indented text', () => {
    const [list] = parseMarkdown('- item one\n\n  more about one\n- item two');
    if (list?.t !== 'list') throw new Error('not a list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toHaveLength(2);
  });

  it('joins lazy continuation lines into the item', () => {
    const [list] = parseMarkdown('- first line\nsecond line\n- next');
    if (list?.t !== 'list') throw new Error('not a list');
    expect(list.items[0]?.[0]).toMatchObject({
      t: 'p',
      c: [{ t: 'text', v: 'first line\nsecond line' }],
    });
  });

  it('ends a list at a different marker or a blank line', () => {
    const blocks = parseMarkdown('1) one\n2) two\n\nafter');
    expect(blocks.map((b) => b.t)).toEqual(['list', 'p']);
    expect(blocks[0]).toMatchObject({ ordered: true, start: 1 });
    expect(parseMarkdown('- a\n1. b').map((b) => b.t)).toEqual(['list', 'list']);
  });

  it('stops a paragraph before a table or a block', () => {
    expect(parseMarkdown('text\n| a | b |\n|---|---|\n| 1 | 2 |').map((b) => b.t)).toEqual([
      'p',
      'table',
    ]);
    expect(parseMarkdown('text\n# Title').map((b) => b.t)).toEqual(['p', 'h']);
  });

  it('supports tilde fences, closing hashes and underscore emphasis', () => {
    expect(parseMarkdown('~~~\nraw\n~~~')[0]).toEqual({
      t: 'code',
      lang: '',
      v: 'raw',
      open: false,
    });
    expect(parseMarkdown('## Title ##')[0]).toEqual({
      t: 'h',
      level: 2,
      c: [{ t: 'text', v: 'Title' }],
    });
    expect(parseInline('an _em_ and __strong__')).toEqual([
      { t: 'text', v: 'an ' },
      { t: 'em', c: [{ t: 'text', v: 'em' }] },
      { t: 'text', v: ' and ' },
      { t: 'strong', c: [{ t: 'text', v: 'strong' }] },
    ]);
  });

  it('leaves unmatched markers and backticks as text', () => {
    expect(parseInline('a * b and `open')).toEqual([{ t: 'text', v: 'a * b and `open' }]);
    expect(parseInline('[no link] here')).toEqual([{ t: 'text', v: '[no link] here' }]);
  });

  it('parses centred and unaligned table columns, and short rows', () => {
    const [t] = parseMarkdown('a | b | c\n:-: | --- | :--\n1 | 2');
    if (t?.t !== 'table') throw new Error('not a table');
    expect(t.align).toEqual(['center', undefined, 'left']);
    expect(t.rows[0]?.[2]).toEqual([]);
  });
});
