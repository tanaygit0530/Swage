import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChangeSet,
  ChangeSetStore,
  type ChangeSetError,
  type FileReader,
  type Result,
} from '../../../src/changeset/changeSet';
import { hashText } from '../../../src/changeset/text';

const CLI_PY = `import click


@click.command("routes", short_help="Show the routes for the app.")
@with_appcontext
def routes_command(sort: str, all_methods: bool) -> None:
    """Show all registered routes with endpoints and methods."""
    rules = list(current_app.url_map.iter_rules())
    if not rules:
        click.echo("No routes were registered.")
        return


cli = FlaskGroup(
    name="flask",
)
`;

function memoryReader(files: Record<string, string>): FileReader & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return { files: map, read: (p) => Promise.resolve(map.get(p)) };
}

function errorOf<T>(r: Result<T>): ChangeSetError {
  if (r.ok) throw new Error('expected an error result');
  return r.error;
}

function valueOf<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}: ${r.error.message}`);
  return r.value;
}

describe('ChangeSet', () => {
  let reader: ReturnType<typeof memoryReader>;
  let cs: ChangeSet;

  beforeEach(() => {
    reader = memoryReader({
      'src/flask/cli.py': CLI_PY,
      'docs/cli.rst': 'Commands\n========\n\nroutes\n',
      'win.txt': 'alpha\r\nbeta\r\ngamma\r\n',
      'dup.py': 'x = 1\nx = 1\nx = 1\n',
      'no-eol.txt': 'one\ntwo',
    });
    cs = new ChangeSet('task-1', reader);
  });

  describe('declare_context', () => {
    it('is required before any staging', async () => {
      const r = await cs.stage({ kind: 'write', path: 'docs/cli.rst', content: 'x' });
      expect(errorOf(r).code).toBe('context_not_declared');
    });

    it('rejects an empty or reasonless declaration', () => {
      expect(errorOf(cs.declareContext({ plan: [], files: [] })).code).toBe('invalid_input');
      expect(
        errorOf(cs.declareContext({ plan: [], files: [{ path: 'a', reason: ' ' }] })).code,
      ).toBe('invalid_input');
    });

    it('records the plan and merges files across calls', () => {
      valueOf(
        cs.declareContext({ plan: ['add command'], files: [{ path: './a.py', reason: 'r1' }] }),
      );
      valueOf(cs.declareContext({ plan: [], files: [{ path: 'b.py', reason: 'r2' }] }));
      expect(cs.declaredContext).toEqual({
        plan: ['add command'],
        files: [
          { path: 'a.py', reason: 'r1' },
          { path: 'b.py', reason: 'r2' },
        ],
      });
    });

    it('refuses staging an undeclared file', async () => {
      cs.declareContext({ plan: [], files: [{ path: 'docs/cli.rst', reason: 'docs' }] });
      const e = errorOf(await cs.stage({ kind: 'write', path: 'src/flask/cli.py', content: 'x' }));
      expect(e.code).toBe('undeclared_file');
      expect(e.message).toMatch(/declare_context/);
    });
  });

  describe('anchored edits', () => {
    beforeEach(() => {
      cs.declareContext({
        plan: ['add config command'],
        files: [
          { path: 'src/flask/cli.py', reason: 'register the command' },
          { path: 'win.txt', reason: 'crlf' },
          { path: 'dup.py', reason: 'dup' },
          { path: 'no-eol.txt', reason: 'eol' },
          { path: 'new.py', reason: 'new file' },
        ],
      });
    });

    it('stages a find/replace edit and reports blocks', async () => {
      const s = valueOf(
        await cs.stage({
          kind: 'edit',
          path: 'src/flask/cli.py',
          edits: [
            {
              find: '        click.echo("No routes were registered.")\n',
              replace: '        click.echo("No routes registered.")\n',
            },
          ],
        }),
      );
      expect(s).toMatchObject({ kind: 'modify', blockCount: 1, linesAdded: 1, linesRemoved: 1 });
    });

    it('reports anchor_not_found, with a whitespace hint when only spacing differs', async () => {
      const miss = errorOf(
        await cs.stage({
          kind: 'edit',
          path: 'src/flask/cli.py',
          edits: [{ find: 'def config_command', replace: '' }],
        }),
      );
      expect(miss).toMatchObject({ code: 'anchor_not_found', editIndex: 0, matchCount: 0 });

      const spacing = errorOf(
        await cs.stage({
          kind: 'edit',
          path: 'src/flask/cli.py',
          edits: [{ find: 'if not rules:\n  click.echo(', replace: '' }],
        }),
      );
      expect(spacing.code).toBe('anchor_not_found');
      expect(spacing.message).toMatch(/whitespace/);

      const empty = errorOf(
        await cs.stage({
          kind: 'edit',
          path: 'src/flask/cli.py',
          edits: [{ find: '', replace: 'x' }],
        }),
      );
      expect(empty.code).toBe('anchor_not_found');
    });

    it('reports anchor_ambiguous with the match count, and accepts an occurrence', async () => {
      const e = errorOf(
        await cs.stage({
          kind: 'edit',
          path: 'dup.py',
          edits: [{ find: 'x = 1', replace: 'x = 2' }],
        }),
      );
      expect(e).toMatchObject({ code: 'anchor_ambiguous', matchCount: 3 });

      valueOf(
        await cs.stage({
          kind: 'edit',
          path: 'dup.py',
          edits: [{ find: 'x = 1', replace: 'x = 2', occurrence: 2 }],
        }),
      );
      expect(cs.result().changes).toEqual([]);
      cs.acceptAll();
      expect(cs.result().changes[0]).toMatchObject({ content: 'x = 1\nx = 2\nx = 1\n' });
    });

    it('reports bad_occurrence for out-of-range or non-integer occurrences', async () => {
      for (const occurrence of [0, 4, 1.5]) {
        const e = errorOf(
          await cs.stage({
            kind: 'edit',
            path: 'dup.py',
            edits: [{ find: 'x = 1', replace: 'y', occurrence }],
          }),
        );
        expect(e).toMatchObject({ code: 'bad_occurrence', matchCount: 3 });
      }
    });

    it('applies a batch of edits atomically', async () => {
      const r = await cs.stage({
        kind: 'edit',
        path: 'src/flask/cli.py',
        edits: [
          { find: 'import click\n', replace: 'import json\n\nimport click\n' },
          { find: 'does-not-exist', replace: '' },
        ],
      });
      expect(errorOf(r)).toMatchObject({ code: 'anchor_not_found', editIndex: 1 });
      expect(cs.review()).toEqual([]);
    });

    it('edits a CRLF file with LF anchors and keeps CRLF', async () => {
      valueOf(
        await cs.stage({
          kind: 'edit',
          path: 'win.txt',
          edits: [{ find: 'beta\ngamma', replace: 'BETA\ngamma' }],
        }),
      );
      cs.acceptAll();
      const [change] = cs.result().changes;
      expect(change).toMatchObject({ op: 'modify', content: 'alpha\r\nBETA\r\ngamma\r\n' });
    });

    it('refuses edits to a missing file and to an empty edit list', async () => {
      expect(
        errorOf(
          await cs.stage({ kind: 'edit', path: 'new.py', edits: [{ find: 'a', replace: 'b' }] }),
        ).code,
      ).toBe('file_not_found');
      expect(errorOf(await cs.stage({ kind: 'edit', path: 'dup.py', edits: [] })).code).toBe(
        'invalid_input',
      );
    });

    it('drops a file whose edits cancel out', async () => {
      await cs.stage({
        kind: 'edit',
        path: 'dup.py',
        edits: [{ find: 'x = 1\nx', replace: 'y = 1\nx' }],
      });
      expect(cs.review()).toHaveLength(1);
      await cs.stage({
        kind: 'edit',
        path: 'dup.py',
        edits: [{ find: 'y = 1', replace: 'x = 1' }],
      });
      expect(cs.review()).toEqual([]);
    });
  });

  describe('full-file writes, creates and deletes', () => {
    beforeEach(() => {
      cs.declareContext({
        plan: [],
        files: [
          'src/flask/cli.py',
          'docs/cli.rst',
          'win.txt',
          'no-eol.txt',
          'tests/test_config.py',
        ].map((path) => ({ path, reason: 'test' })),
      });
    });

    it('refuses a rewrite under 20 percent of the original as suspicious_truncation', async () => {
      const e = errorOf(
        await cs.stage({ kind: 'write', path: 'src/flask/cli.py', content: 'import click\n' }),
      );
      expect(e.code).toBe('suspicious_truncation');
      expect(e.message).toMatch(/\d+%/);
    });

    it('accepts a rewrite of at least 20 percent', async () => {
      const content = CLI_PY.slice(0, Math.ceil(CLI_PY.length * 0.5));
      expect((await cs.stage({ kind: 'write', path: 'src/flask/cli.py', content })).ok).toBe(true);
    });

    it('keeps CRLF and the absent final newline on full writes', async () => {
      valueOf(await cs.stage({ kind: 'write', path: 'win.txt', content: 'alpha\nbeta\nGAMMA\n' }));
      valueOf(await cs.stage({ kind: 'write', path: 'no-eol.txt', content: 'one\nTWO\n' }));
      cs.acceptAll();
      const byPath = Object.fromEntries(cs.result().changes.map((c) => [c.path, c]));
      expect(byPath['win.txt']).toMatchObject({ content: 'alpha\r\nbeta\r\nGAMMA\r\n' });
      expect(byPath['no-eol.txt']).toMatchObject({ content: 'one\nTWO' });
    });

    it('creates a new file and can then edit it', async () => {
      const s = valueOf(
        await cs.stage({
          kind: 'write',
          path: 'tests/test_config.py',
          content: 'def test_a():\n    pass\n',
        }),
      );
      expect(s.kind).toBe('create');
      valueOf(
        await cs.stage({
          kind: 'edit',
          path: 'tests/test_config.py',
          edits: [{ find: 'pass', replace: 'assert True' }],
        }),
      );
      cs.acceptAll();
      expect(cs.result().changes).toEqual([
        { op: 'create', path: 'tests/test_config.py', content: 'def test_a():\n    assert True\n' },
      ]);
    });

    it('stages a delete, which applies only when every block is accepted', async () => {
      valueOf(await cs.stage({ kind: 'delete', path: 'docs/cli.rst' }));
      expect(cs.review()[0]?.kind).toBe('delete');
      cs.acceptAll();
      expect(cs.result().changes).toEqual([
        {
          op: 'delete',
          path: 'docs/cli.rst',
          baseHash: hashText('Commands\n========\n\nroutes\n'),
        },
      ]);

      const [ids] = [valueOf(cs.split('docs/cli.rst', 'docs/cli.rst#1'))];
      cs.reject('docs/cli.rst', ids[0] ?? '');
      expect(cs.result().changes[0]).toMatchObject({ op: 'modify', content: 'Commands\n' });

      expect(
        errorOf(
          await cs.stage({
            kind: 'edit',
            path: 'docs/cli.rst',
            edits: [{ find: 'a', replace: 'b' }],
          }),
        ).code,
      ).toBe('file_not_found');
      expect(errorOf(await cs.stage({ kind: 'delete', path: 'tests/test_config.py' })).code).toBe(
        'file_not_found',
      );
    });

    it('creates an empty file through the file-level decision', async () => {
      valueOf(await cs.stage({ kind: 'write', path: 'tests/test_config.py', content: '' }));
      expect(cs.result().changes).toEqual([]);
      cs.acceptAll('tests/test_config.py');
      expect(cs.result().changes).toEqual([
        { op: 'create', path: 'tests/test_config.py', content: '' },
      ]);
    });
  });

  describe('review decisions', () => {
    beforeEach(async () => {
      cs.declareContext({ plan: [], files: [{ path: 'src/flask/cli.py', reason: 'r' }] });
      valueOf(
        await cs.stage({
          kind: 'edit',
          path: 'src/flask/cli.py',
          edits: [
            { find: 'import click\n', replace: 'import json\n\nimport click\n' },
            { find: 'No routes were registered.', replace: 'No routes registered.' },
            {
              find: '    name="flask",\n',
              replace: '    name="flask",\n    add_version_option=True,\n',
            },
          ],
        }),
      );
    });

    it('starts with every block pending and nothing to apply', () => {
      const [file] = cs.review();
      expect(file?.blocks.map((b) => b.state)).toEqual(['pending', 'pending', 'pending']);
      expect(cs.result()).toMatchObject({ changes: [], pending: expect.any(Array) });
    });

    it('applies only accepted blocks (partial acceptance)', () => {
      const ids = cs.review()[0]?.blocks.map((b) => b.id) ?? [];
      valueOf(cs.accept('src/flask/cli.py', ids[0] ?? ''));
      valueOf(cs.reject('src/flask/cli.py', ids[1] ?? ''));
      const result = cs.result();
      expect(result.accepted).toEqual([ids[0]]);
      expect(result.rejected).toEqual([ids[1]]);
      expect(result.pending).toEqual([ids[2]]);
      const content = (result.changes[0] as { content: string }).content;
      expect(content.startsWith('import json\n')).toBe(true);
      expect(content).toContain('No routes were registered.');
      expect(content).not.toContain('add_version_option');
    });

    it('accepts all then rejects all', () => {
      valueOf(cs.acceptAll('src/flask/cli.py'));
      expect(cs.result().accepted).toHaveLength(3);
      valueOf(cs.rejectAll());
      expect(cs.result()).toMatchObject({ changes: [], accepted: [] });
      expect(errorOf(cs.acceptAll('missing.py')).code).toBe('file_not_found');
    });

    it('splits a block, keeps its state, then accepts one part', () => {
      const first = cs.review()[0]?.blocks[0];
      expect(first?.newLines).toEqual(['import json\n', '\n']);
      valueOf(cs.reject('src/flask/cli.py', first?.id ?? ''));
      expect(first?.oldLines).toEqual([]);
      const parts = valueOf(cs.split('src/flask/cli.py', first?.id ?? '', 0, 1));
      expect(parts).toHaveLength(2);
      expect(
        cs
          .review()[0]
          ?.blocks.slice(0, 2)
          .map((b) => b.state),
      ).toEqual(['rejected', 'rejected']);
      valueOf(cs.accept('src/flask/cli.py', parts[0] ?? ''));
      const content = (cs.result().changes[0] as { content: string }).content;
      expect(content.startsWith('import json\nimport click\n')).toBe(true);
    });

    it('reports unknown blocks and invalid splits', () => {
      expect(errorOf(cs.accept('src/flask/cli.py', 'nope')).code).toBe('unknown_block');
      expect(errorOf(cs.reject('other.py', 'x')).code).toBe('unknown_block');
      const id = cs.review()[0]?.blocks[1]?.id ?? '';
      expect(errorOf(cs.split('src/flask/cli.py', id, 0, 0)).code).toBe('invalid_split');
    });
  });

  describe('status', () => {
    it('closes staging after submit and clears on discard', async () => {
      cs.declareContext({ plan: [], files: [{ path: 'docs/cli.rst', reason: 'r' }] });
      cs.submit();
      expect(cs.status).toBe('submitted');
      expect(errorOf(await cs.stage({ kind: 'delete', path: 'docs/cli.rst' })).code).toBe(
        'not_staging',
      );
      cs.markApplied();
      expect(cs.status).toBe('applied');
      cs.markUndone();
      expect(cs.status).toBe('undone');
      cs.discard();
      expect(cs.status).toBe('discarded');
      expect(cs.review()).toEqual([]);
    });
  });
});

describe('ChangeSetStore', () => {
  it('keys change sets by task id', () => {
    const store = new ChangeSetStore(memoryReader({}));
    const a = store.get('t1');
    expect(store.get('t1')).toBe(a);
    expect(store.get('t2')).not.toBe(a);
    expect(store.has('t1')).toBe(true);
    store.discard('t1');
    expect(store.has('t1')).toBe(false);
    expect(a.status).toBe('discarded');
  });
});

describe('ChangeSet: anchors copied from redacted tool results', () => {
  // Built at run time so no key-shaped literal is in the repository.
  const hidden = ['tok', 'live', 'Zq81vX4mP2'].join('_');
  const original = `def test_config(app):\n    app.config["API_TOKEN"] = "${hidden}"\n    assert run()\n`;

  async function staged(edits: { find: string; replace: string }[]): Promise<Result<unknown>> {
    const cs = new ChangeSet('t', memoryReader({ 'tests/test_cli.py': original }));
    valueOf(
      cs.declareContext({ plan: ['p'], files: [{ path: 'tests/test_cli.py', reason: 'r' }] }),
    );
    const r = await cs.stage({ kind: 'edit', path: 'tests/test_cli.py', edits });
    return r.ok ? { ok: true, value: cs.staged('tests/test_cli.py')?.content } : r;
  }

  it('matches a marker against the hidden value and keeps it where the replacement keeps the marker', async () => {
    const r = await staged([
      {
        find: '    app.config["API_TOKEN"] = "[REDACTED:password_assignment]"\n    assert run()',
        replace:
          '    app.config["API_TOKEN"] = "[REDACTED:password_assignment]"\n    assert run() == 0',
      },
    ]);
    expect(valueOf(r)).toBe(original.replace('assert run()', 'assert run() == 0'));
    expect(valueOf(r)).toContain(hidden);
  });

  it('lets the agent replace the hidden value, and matches a marker at the end of the anchor', async () => {
    const r = await staged([
      {
        find: 'app.config["API_TOKEN"] = [REDACTED:password_assignment]',
        replace: 'app.config["API_TOKEN"] = "x"',
      },
    ]);
    expect(valueOf(r)).toContain('app.config["API_TOKEN"] = "x"\n');
    expect(valueOf(r)).not.toContain(hidden);
  });

  it('never matches a marker across lines', async () => {
    const r = await staged([{ find: 'def test_config[REDACTED:x]assert run()', replace: 'y' }]);
    expect(errorOf(r).code).toBe('anchor_not_found');
  });
});
