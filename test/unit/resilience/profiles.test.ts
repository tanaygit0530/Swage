import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayName,
  HOSTED_TIMEOUTS,
  loadProfilesFile,
  LOCAL_TIMEOUTS,
  parseProfilesText,
  profilesFrom,
  providerName,
  resolveProfiles,
} from '../../../src/resilience/profiles';

describe('model profiles (blueprint sections 8 and 9)', () => {
  it('reads the committed YAML example: four profiles, labels, layered timeouts', () => {
    const { file, profiles } = loadProfilesFile(path.join(__dirname, '..', '..', '..'));
    expect(['config/models.example.yaml', 'config/models.yaml', 'config/models.json']).toContain(
      file,
    );
    const example = loadProfilesFile(mkdirCopy('config/models.example.yaml')).profiles;
    expect(example.map((p) => [p.name, p.kind, p.label])).toEqual([
      ['primary', 'hosted', 'Gemini'],
      ['fallback-1', 'hosted', 'Groq'],
      ['fallback-2', 'local', 'Ollama'],
      ['fallback-3', 'local', 'llama.cpp'],
    ]);
    expect(example[2]?.timeouts).toEqual(LOCAL_TIMEOUTS);
    expect(example[1]?.timeouts.firstTokenMs).toBe(30_000);
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('fills missing timeouts from the kind, so a slow local model gets generous defaults', () => {
    const [hosted, local, mixed] = resolveProfiles([
      { name: 'a', trueforgeModel: 'p/m' },
      { name: 'b', kind: 'local', trueforgeModel: 'ollama/x' },
      { name: 'c', kind: 'local', trueforgeModel: 'ollama/x', timeouts: { firstTokenMs: 300000 } },
    ]);
    expect(hosted?.kind).toBe('hosted');
    expect(hosted?.timeouts).toEqual(HOSTED_TIMEOUTS);
    expect(local?.timeouts).toEqual(LOCAL_TIMEOUTS);
    expect(mixed?.timeouts).toEqual({ ...LOCAL_TIMEOUTS, firstTokenMs: 300_000 });
    expect(LOCAL_TIMEOUTS.firstTokenMs).toBeGreaterThan(HOSTED_TIMEOUTS.firstTokenMs);
  });

  it('names the provider without knowing any model: labels come from the FQN or the config', () => {
    expect(providerName('google-gemini/gemini-3-5-flash')).toBe('Gemini');
    expect(providerName('groq/gpt-oss-120b')).toBe('Groq');
    expect(providerName('organisers_llm/some-model')).toBe('Llm');
    expect(displayName({ trueforgeModel: 'x/y', label: 'Their model' })).toBe('Their model');
    expect(displayName({ trueforgeModel: 'acme/y' })).toBe('Acme');
  });

  it('accepts a bare list or { profiles }, YAML or JSON', () => {
    expect(parseProfilesText('- name: p\n  trueforgeModel: a/b\n')[0]?.name).toBe('p');
    expect(parseProfilesText('{"profiles":[{"name":"p","trueforgeModel":"a/b"}]}')).toHaveLength(1);
  });

  it('rejects bad profiles with a pointed message', () => {
    expect(() => resolveProfiles([])).toThrow(/non-empty list/);
    expect(() => resolveProfiles({ nope: 1 })).toThrow(/non-empty list/);
    expect(() => resolveProfiles([{ name: 'p', trueforgeModel: 'no-slash' }])).toThrow(
      /profile 0 trueforgeModel: must be a TrueForge model FQN/,
    );
    expect(() =>
      resolveProfiles([
        { name: 'p', trueforgeModel: 'a/b' },
        { name: 'p', trueforgeModel: 'a/c' },
      ]),
    ).toThrow(/duplicate profile name "p"/);
    expect(() => resolveProfiles([{ name: 'p', trueforgeModel: 'a/b', apiKey: 'x' }])).toThrow(
      /profile 0/,
    );
    expect(() =>
      resolveProfiles([{ name: 'p', trueforgeModel: 'a/b', timeouts: { stallMs: 5 } }]),
    ).toThrow(/timeouts.stallMs/);
    expect(() => parseProfilesText('profiles: [', 'bad.yaml')).toThrow(/^bad.yaml:/);
  });

  it('prefers the swage.models setting, then the profiles file next to the extension', () => {
    expect(profilesFrom([{ name: 's', trueforgeModel: 'a/b' }])[0]?.name).toBe('s');
    const dir = mkdirCopy('config/models.example.yaml');
    expect(profilesFrom([], dir)[0]?.name).toBe('primary');
    expect(() => profilesFrom([])).toThrow(/swage.models/);
    const empty = mkdtempSync(path.join(tmpdir(), 'swage-prof-'));
    expect(() => loadProfilesFile(empty)).toThrow(/No profiles file/);
    rmSync(empty, { recursive: true, force: true });
  });
});

/** A temp folder with only the committed example in config/. */
function mkdirCopy(rel: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'swage-prof-'));
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(
    path.join(dir, rel),
    readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8'),
  );
  return dir;
}
