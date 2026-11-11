import { beforeEach, describe, expect, it } from 'vitest';
import { Applier, type WorkspaceFs } from '../../../src/changeset/apply';
import { ChangeSet, type FileChange } from '../../../src/changeset/changeSet';
import { hashText } from '../../../src/changeset/text';

class MemoryFs implements WorkspaceFs {
  readonly files: Map<string, string>;
  failOn: string | undefined;
  failRemoveOn: string | undefined;
  writes = 0;

  constructor(initial: Record<string, string>) {
    this.files = new Map(Object.entries(initial));
  }

  read(path: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  write(path: string, content: string): Promise<void> {
    if (path === this.failOn) return Promise.reject(new Error('disk full'));
    this.writes++;
    this.files.set(path, content);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    if (path === this.failRemoveOn) return Promise.reject(new Error('locked'));
    this.files.delete(path);
    return Promise.resolve();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const HELPERS = 'def get_debug_flag():\n    return bool(val)\n';
const CLI = 'import click\n\ncli = FlaskGroup()\n';
const WIN = 'line one\r\nline two\r\n';
const DOCS = 'Commands\n========\n';

function modify(path: string, base: string, content: string): FileChange {
  return { op: 'modify', path, baseHash: hashText(base), content };
}

describe('Applier', () => {
  let fs: MemoryFs;
  let applier: Applier;
  let original: Record<string, string>;

  beforeEach(() => {
    fs = new MemoryFs({
      'helpers.py': HELPERS,
      'cli.py': CLI,
      'win.txt': WIN,
      'docs/cli.rst': DOCS,
    });
    original = fs.snapshot();
    let t = 0;
    applier = new Applier(fs, { now: () => ++t });
  });

  it('applies modify, create and delete together and records a checkpoint', async () => {
    const r = await applier.apply('task-b', [
      modify('cli.py', CLI, 'import click\nimport json\n\ncli = FlaskGroup()\n'),
      { op: 'create', path: 'tests/test_config.py', content: 'def test_config():\n    pass\n' },
      { op: 'delete', path: 'docs/cli.rst', baseHash: hashText(DOCS) },
    ]);
    expect(r.ok).toBe(true);
    expect(fs.files.get('cli.py')).toContain('import json');
    expect(fs.files.get('tests/test_config.py')).toBe('def test_config():\n    pass\n');
    expect(fs.files.has('docs/cli.rst')).toBe(false);
    if (r.ok) {
      expect(r.checkpoint.taskId).toBe('task-b');
      expect(
        r.checkpoint.entries.map((e) => [
          e.path,
          e.before === undefined,
          e.afterHash === undefined,
        ]),
      ).toEqual([
        ['cli.py', false, false],
        ['tests/test_config.py', true, false],
        ['docs/cli.rst', false, true],
      ]);
    }
    expect(applier.canUndo).toBe(true);
  });

  it('applies, undoes, and then reports nothing left to undo', async () => {
    await applier.apply('t', [
      modify(
        'helpers.py',
        HELPERS,
        HELPERS.replace('bool(val)', 'bool(val and val.lower() != "off")'),
      ),
      { op: 'create', path: 'new.py', content: 'x = 1\n' },
      { op: 'delete', path: 'docs/cli.rst', baseHash: hashText(DOCS) },
    ]);
    expect(fs.snapshot()).not.toEqual(original);

    const undo = await applier.undo();
    expect(undo.ok).toBe(true);
    expect(fs.snapshot()).toEqual(original);

    const again = await applier.undo();
    expect(again).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'nothing_to_undo' }),
    });
    expect(fs.snapshot()).toEqual(original);
  });

  it('keeps two undo levels and drops the oldest', async () => {
    const v1 = 'v1\n';
    const v2 = 'v2\n';
    const v3 = 'v3\n';
    await applier.apply('a', [modify('cli.py', CLI, v1)]);
    await applier.apply('b', [modify('cli.py', v1, v2)]);
    await applier.apply('c', [modify('cli.py', v2, v3)]);
    expect(applier.history.map((c) => c.taskId)).toEqual(['b', 'c']);

    expect((await applier.undo()).ok).toBe(true);
    expect(fs.files.get('cli.py')).toBe(v2);
    expect((await applier.undo()).ok).toBe(true);
    expect(fs.files.get('cli.py')).toBe(v1);
    const third = await applier.undo();
    expect(third.ok).toBe(false);
    expect(fs.files.get('cli.py')).toBe(v1);
  });

  it('refuses the whole apply when any file changed on disk since staging', async () => {
    fs.files.set('helpers.py', HELPERS + '# edited by the user\n');
    const before = fs.snapshot();
    const r = await applier.apply('t', [
      modify('cli.py', CLI, 'changed\n'),
      modify('helpers.py', HELPERS, 'changed\n'),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'conflict') {
      expect(r.error.conflicts).toEqual([{ path: 'helpers.py', reason: 'changed_on_disk' }]);
      expect(r.error.message).toMatch(/helpers\.py \(changed on disk\)/);
    }
    expect(fs.snapshot()).toEqual(before);
    expect(fs.writes).toBe(0);
    expect(applier.canUndo).toBe(false);
  });

  it('reports missing files and files that already exist', async () => {
    const r = await applier.apply('t', [
      modify('gone.py', 'x', 'y'),
      { op: 'create', path: 'cli.py', content: 'x' },
      { op: 'delete', path: 'also-gone.py', baseHash: hashText('') },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'conflict') {
      expect(r.error.conflicts.map((c) => c.reason)).toEqual([
        'missing',
        'already_exists',
        'missing',
      ]);
    }
  });

  it('refuses an empty apply and duplicate paths', async () => {
    expect(await applier.apply('t', [])).toMatchObject({
      ok: false,
      error: { code: 'nothing_to_apply' },
    });
    expect(
      await applier.apply('t', [modify('cli.py', CLI, 'a'), modify('cli.py', CLI, 'b')]),
    ).toMatchObject({ ok: false, error: { code: 'duplicate_path', path: 'cli.py' } });
  });

  it('rolls back earlier writes when a later write fails', async () => {
    fs.failOn = 'helpers.py';
    const r = await applier.apply('t', [
      modify('cli.py', CLI, 'new cli\n'),
      { op: 'create', path: 'made.py', content: 'x\n' },
      modify('helpers.py', HELPERS, 'new helpers\n'),
    ]);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'write_failed', path: 'helpers.py', rolledBack: true },
    });
    expect(fs.snapshot()).toEqual(original);
    expect(applier.canUndo).toBe(false);
  });

  it('says so when a rollback step also fails', async () => {
    fs.failOn = 'helpers.py';
    fs.failRemoveOn = 'made.py';
    const r = await applier.apply('t', [
      { op: 'create', path: 'made.py', content: 'x\n' },
      modify('helpers.py', HELPERS, 'new\n'),
    ]);
    expect(r).toMatchObject({ ok: false, error: { code: 'write_failed', rolledBack: false } });
  });

  it('refuses an undo after the user edited an applied file, unless forced', async () => {
    await applier.apply('t', [
      modify('cli.py', CLI, 'applied\n'),
      { op: 'create', path: 'new.py', content: 'n\n' },
      { op: 'delete', path: 'docs/cli.rst', baseHash: hashText(DOCS) },
    ]);
    fs.files.set('cli.py', 'applied\n# user edit\n');
    fs.files.delete('new.py');
    fs.files.set('docs/cli.rst', 'recreated by user\n');

    const refused = await applier.undo();
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.code === 'conflict') {
      expect(refused.error.conflicts).toEqual([
        { path: 'cli.py', reason: 'changed_on_disk' },
        { path: 'new.py', reason: 'missing' },
        { path: 'docs/cli.rst', reason: 'already_exists' },
      ]);
    }
    expect(fs.files.get('cli.py')).toBe('applied\n# user edit\n');
    expect(applier.canUndo).toBe(true);

    const forced = await applier.undo({ force: true });
    expect(forced.ok).toBe(true);
    expect(fs.snapshot()).toEqual(original);
  });

  it('reports a failed undo write and keeps the checkpoint', async () => {
    await applier.apply('t', [modify('cli.py', CLI, 'a\n'), modify('helpers.py', HELPERS, 'b\n')]);
    fs.failOn = 'helpers.py';
    const r = await applier.undo();
    expect(r).toMatchObject({ ok: false, error: { code: 'write_failed', rolledBack: true } });
    expect(fs.files.get('cli.py')).toBe('a\n');
    expect(applier.canUndo).toBe(true);
  });

  it('restores history passed in after a reload', async () => {
    await applier.apply('t', [modify('cli.py', CLI, 'a\n')]);
    const reloaded = new Applier(fs, { history: applier.history });
    expect((await reloaded.undo()).ok).toBe(true);
    expect(fs.files.get('cli.py')).toBe(CLI);
  });

  it('preserves CRLF line endings and trailing newlines end to end from the change set', async () => {
    const cs = new ChangeSet('crlf', fs);
    cs.declareContext({ plan: [], files: [{ path: 'win.txt', reason: 'crlf file' }] });
    const staged = await cs.stage({
      kind: 'edit',
      path: 'win.txt',
      edits: [{ find: 'line two\n', replace: 'line two\nline three\n' }],
    });
    expect(staged.ok).toBe(true);
    cs.acceptAll();
    const r = await applier.apply('crlf', cs.result().changes);
    expect(r.ok).toBe(true);
    expect(fs.files.get('win.txt')).toBe('line one\r\nline two\r\nline three\r\n');
    await applier.undo();
    expect(fs.files.get('win.txt')).toBe(WIN);
  });

  it('applies only the accepted blocks of a partially reviewed change set', async () => {
    const cs = new ChangeSet('partial', fs);
    cs.declareContext({ plan: [], files: [{ path: 'cli.py', reason: 'r' }] });
    await cs.stage({
      kind: 'write',
      path: 'cli.py',
      content: 'import click\nimport json\n\ncli = FlaskGroup(name="flask")\n',
    });
    const blocks = cs.review()[0]?.blocks ?? [];
    expect(blocks).toHaveLength(2);
    cs.accept('cli.py', blocks[1]?.id ?? '');
    cs.reject('cli.py', blocks[0]?.id ?? '');
    await applier.apply('partial', cs.result().changes);
    expect(fs.files.get('cli.py')).toBe('import click\n\ncli = FlaskGroup(name="flask")\n');
  });

  it('caps maxUndo at one or more', () => {
    expect(new Applier(fs, { maxUndo: 0 }).history).toEqual([]);
  });
});
