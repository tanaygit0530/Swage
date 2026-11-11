import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_PREFIX, RUNNING_CONTEXT_KEY, stubMessage } from '../../src/commands';

interface Manifest {
  contributes: {
    commands: { command: string; title: string; category: string }[];
    keybindings: { command: string; key: string; mac?: string; when?: string }[];
    configuration: { properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as Manifest;

describe('command manifest', () => {
  it('declares every public command, plus review commands under swage.review.', () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    for (const spec of COMMANDS) expect(declared).toContain(spec.id);
    for (const id of declared) {
      expect(COMMANDS.some((c) => c.id === id) || id.startsWith('swage.review.'), id).toBe(true);
    }
  });

  it('uses the swage. prefix and the Swage category with matching titles', () => {
    for (const c of manifest.contributes.commands) expect(c.category).toBe('Swage');
    for (const spec of COMMANDS) {
      expect(spec.id.startsWith(COMMAND_PREFIX)).toBe(true);
      const entry = manifest.contributes.commands.find((c) => c.command === spec.id);
      expect(entry?.category).toBe('Swage');
      expect(entry?.title).toBe(spec.title);
    }
  });

  it('binds Cmd+K Cmd+I to inline edit and Escape to stop only while running', () => {
    const { keybindings } = manifest.contributes;
    expect(keybindings).toContainEqual(
      expect.objectContaining({ command: 'swage.inlineEdit', mac: 'cmd+k cmd+i' }),
    );
    expect(keybindings).toContainEqual(
      expect.objectContaining({ command: 'swage.stop', key: 'escape', when: RUNNING_CONTEXT_KEY }),
    );
  });

  it('declares the settings from blueprint section 9', () => {
    expect(Object.keys(manifest.contributes.configuration.properties).sort()).toEqual([
      'swage.autoStart',
      'swage.budgets',
      'swage.ignore',
      'swage.models',
      'swage.truefoundry.baseUrl',
    ]);
  });

  it('builds a readable stub message', () => {
    expect(stubMessage({ id: 'swage.doctor', title: 'Doctor' })).toBe(
      'Swage: Doctor is not implemented yet.',
    );
  });
});
