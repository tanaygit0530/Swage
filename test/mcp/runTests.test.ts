import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declareContext } from '../../src/mcp/tools/declareContext';
import { runTests } from '../../src/mcp/tools/runTests';
import { stageEdit } from '../../src/mcp/tools/stageEdit';
import { startHarness, treeHash, type Harness } from './harness';

/** A tiny npm project whose test passes only when VALUE is 2, and which writes files. */
const FILES = {
  'package.json': JSON.stringify({
    name: 'ws',
    private: true,
    scripts: { test: 'node check.js' },
  }),
  'check.js': [
    "const fs = require('fs');",
    "fs.writeFileSync('report.txt', 'ran');",
    "fs.appendFileSync('data.txt', 'more');",
    "if (fs.existsSync('remove-me.txt')) fs.unlinkSync('remove-me.txt');",
    "const v = require('./value.js');",
    "if (process.env.GROQ_API_KEY) { console.log('LEAK'); }",
    "console.log('value is ' + v);",
    "if (process.argv.includes('--hang')) setInterval(() => {}, 1000);",
    'else process.exit(v === 2 ? 0 : 1);',
    '',
  ].join('\n'),
  'value.js': 'module.exports = 1;\n',
  'data.txt': 'data',
  'remove-me.txt': 'x',
};

let h: Harness;
beforeAll(async () => {
  h = await startHarness([declareContext, stageEdit, runTests], { files: FILES });
});
afterAll(() => h.close());

describe('run_tests', () => {
  it('runs the test command in a shadow copy, reports changed files, and leaves the workspace alone', async () => {
    h.ctx.tasks.start('t1');
    const before = treeHash(h.root);
    process.env['GROQ_API_KEY'] = 'should-not-leak';
    const r = await h.call('run_tests', { command: 'npm test' });
    delete process.env['GROQ_API_KEY'];
    const text = h.text(r);
    expect(text).toContain('Command: npm test');
    expect(text).toContain('with 0 staged file(s) applied');
    expect(text).toMatch(/Exit code 1 in \d+ ms\./);
    expect(text).toContain('+ report.txt (created)');
    expect(text).toContain('~ data.txt (modified)');
    expect(text).toContain('- remove-me.txt (deleted)');
    expect(text).toContain('value is 1');
    expect(text).not.toContain('LEAK');
    expect(treeHash(h.root)).toBe(before);
    expect(h.logs.some((l) => /^shadow copy \d+ ms, command \d+ ms, total \d+ ms$/.test(l))).toBe(
      true,
    );
  });

  it('sees the staged edits', async () => {
    h.ctx.tasks.start('t2');
    await h.call('declare_context', {
      plan: ['fix value'],
      files: [{ path: 'value.js', reason: 'the value' }],
    });
    await h.call('stage_edit', {
      path: 'value.js',
      kind: 'write',
      content: 'module.exports = 2;\n',
    });
    const text = h.text(await h.call('run_tests', { command: 'npm test' }));
    expect(text).toContain('with 1 staged file(s) applied (value.js)');
    expect(text).toMatch(/Exit code 0 in \d+ ms\./);
    expect(text).toContain('value is 2');
  });

  it('kills a hanging test run at the timeout', async () => {
    h.ctx.tasks.start('t3');
    const r = await h.call('run_tests', { command: 'npm test -- --hang', timeout_seconds: 2 });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('"code": "timeout"');
    expect(h.text(r)).toContain('Timed out after 2 s; the process tree was killed.');
  });

  it('discards the result and kills the run when the task is cancelled', async () => {
    h.ctx.tasks.start('t4');
    const started = Date.now();
    const pending = h.call('run_tests', { command: 'npm test -- --hang', timeout_seconds: 60 });
    setTimeout(() => h.ctx.tasks.cancel('t4'), 1500);
    const r = await pending;
    expect(JSON.parse(h.text(r)).error.code).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('refuses commands that are not allowlisted tests, with the policy reason', async () => {
    h.ctx.tasks.start('t5');
    const ask = JSON.parse(h.text(await h.call('run_tests', { command: 'pip install flask' })));
    expect(ask.error.code).toBe('not_a_test_command');
    expect(ask.error.message).toMatch(/use run_command/);
    const meta = JSON.parse(h.text(await h.call('run_tests', { command: 'npm test; rm -rf /' })));
    expect(meta.error.code).toBe('destructive_delete');
    const pipe = JSON.parse(h.text(await h.call('run_tests', { command: 'npm test | tee out' })));
    expect(pipe.error.code).toBe('shell_metacharacters');
    const flag = JSON.parse(h.text(await h.call('run_tests', { command: 'pytest -p evil' })));
    expect(flag.error.code).toBe('dangerous_flag');
  });
});
