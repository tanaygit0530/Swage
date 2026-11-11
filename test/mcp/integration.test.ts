import { request } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalList } from '../../src/mcp/context';
import { EDITOR_TOOLS, TOOL_NAMES } from '../../src/mcp/tools/index';
import { startHarness, treeHash, type Harness } from './harness';

/**
 * End to end over real HTTP with the official MCP client: every tool in a realistic agent
 * workflow, then the rules: nothing written to the workspace, every result redacted, timing
 * logged for every tool, and unauthorised requests refused.
 */

const SECRET = 'gs' + 'k_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4';
const FILES = {
  'src/app/__init__.py': '',
  'src/app/cli.py':
    'import click\n\n\n@click.group()\ndef cli():\n    """App commands."""\n\n\n@cli.command("routes")\ndef routes_command():\n    """Show the routes."""\n    click.echo("routes")\n',
  'src/app/config.py': `API_KEY = "${SECRET}"\nDEBUG = False\n\n\ndef load_config():\n    return {"API_KEY": API_KEY, "DEBUG": DEBUG}\n`,
  'tests/test_cli.py':
    'from app.cli import routes_command\n\n\ndef test_routes():\n    assert routes_command\n',
  'docs/cli.md': '# Commands\n\n## routes\n\nShow the routes.\n',
  'package.json': JSON.stringify({ name: 'ws', private: true, scripts: { test: 'node check.js' } }),
  'check.js':
    "const s = require('fs').readFileSync('src/app/cli.py', 'utf8');\nconsole.log(s.includes('config_command') ? 'config command present' : 'config command missing');\nprocess.exit(s.includes('config_command') ? 0 : 1);\n",
};

const approvals = new ApprovalList();
let h: Harness;
const results: CallToolResult[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await h.call(name, args);
  results.push(r);
  return h.text(r);
}

beforeAll(async () => {
  h = await startHarness(EDITOR_TOOLS, { files: FILES, context: { approvals } });
});
afterAll(() => h.close());

describe('editor-tools over HTTP', () => {
  it('lists all nine tools with descriptions, schemas and annotations', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName['read_files']?.readOnlyHint).toBe(true);
    expect(byName['run_command']?.destructiveHint).toBe(true);
    expect(byName['submit_change_set']?.readOnlyHint).toBe(false);
  });

  it('runs a whole agent workflow through every tool without touching the workspace', async () => {
    const before = treeHash(h.root);
    h.ctx.tasks.start('task-b', 'turn-1');

    expect(
      await call('find_relevant_code', { query: 'add a config command to the CLI' }),
    ).toContain('src/app/cli.py');
    expect(await call('repo_map')).toContain('src/app/cli.py: cli, routes_command');
    expect(
      await call('read_files', {
        files: [{ path: 'src/app/cli.py' }, { path: 'src/app/config.py' }],
      }),
    ).toContain('def routes_command():');
    expect(await call('get_symbol', { name: 'load_config' })).toContain('def load_config():');
    expect(
      await call('declare_context', {
        plan: ['Add a config command', 'Document it'],
        files: [
          { path: 'src/app/cli.py', reason: 'register the command' },
          { path: 'docs/cli.md', reason: 'document it' },
        ],
      }),
    ).toContain('Context declared: 2 file(s).');
    expect(
      await call('stage_edit', {
        path: 'src/app/cli.py',
        kind: 'edit',
        edits: [
          {
            find: '    click.echo("routes")\n',
            replace:
              '    click.echo("routes")\n\n\n@cli.command("config")\ndef config_command():\n    """Print the configuration."""\n',
          },
        ],
      }),
    ).toContain('Staged modify of src/app/cli.py');
    expect(
      await call('stage_edit', {
        path: 'docs/cli.md',
        kind: 'edit',
        edits: [
          {
            find: 'Show the routes.\n',
            replace: 'Show the routes.\n\n## config\n\nPrint the configuration.\n',
          },
        ],
      }),
    ).toContain('Staged modify of docs/cli.md');
    expect(await call('run_tests', { command: 'npm test' })).toContain('config command present');
    const cmd = `${process.execPath} check.js`;
    expect(await call('run_command', { command: cmd, reason: 'double-check' })).toContain(
      'approval_required',
    );
    approvals.approve('task-b', cmd);
    expect(await call('run_command', { command: cmd, reason: 'double-check' })).toMatch(
      /Exit code 0/,
    );
    expect(
      await call('submit_change_set', { summary: 'Added the config command and documented it.' }),
    ).toContain('Submitted change set task-b for review: 2 file(s)');

    expect(treeHash(h.root)).toBe(before);
  });

  it('redacted every result and logged timing for every tool', () => {
    expect(results.length).toBeGreaterThanOrEqual(11);
    for (const r of results) expect(h.text(r)).not.toContain(SECRET);
    expect(results.some((r) => h.text(r).includes('[REDACTED:groq_key]'))).toBe(true);
    for (const name of TOOL_NAMES) {
      expect(
        h.logs.some((l) => new RegExp(`^tool ${name} \\d+ ms `).test(l)),
        name,
      ).toBe(true);
    }
  });

  it('refuses unauthorised requests', async () => {
    const status = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve) => {
        const req = request(
          h.server.url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...headers,
            },
          },
          (res) => {
            res.destroy();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', () => resolve(-1));
        req.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'read_files', arguments: { files: [{ path: 'src/app/config.py' }] } },
          }),
        );
      });
    expect(await status({})).toBe(401);
    expect(await status({ authorization: 'Bearer nope' })).toBe(401);
    expect(
      await status({ authorization: `Bearer ${h.server.token}`, host: 'attacker.example' }),
    ).toBe(403);
  });
});
