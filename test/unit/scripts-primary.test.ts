import { describe, expect, it } from 'vitest';
import {
  breakPrimaryText,
  formatOf,
  readPrimary,
  restorePrimaryText,
} from '../../scripts/lib/primary';
import { parseProfilesText } from '../../src/resilience/profiles';

const BROKEN = 'swage-broken/primary';

const SETTINGS = `{
  // Swage profiles for the demo
  "swage.autoStart": false,
  "swage.models": [
    { "name": "primary", "kind": "hosted", "trueforgeModel": "google-gemini/flash-lite" },
    { "name": "fallback-1", "label": "Groq", "trueforgeModel": "groq/oss" },
  ],
}
`;

const YAML = `# comment kept
profiles:
  - name: primary # Gemini
    label: Gemini
    trueforgeModel: google-gemini/flash-lite
    timeouts: { connectMs: 10000, firstTokenMs: 45000, stallMs: 30000, totalMs: 600000 }
  - name: fallback-1
    trueforgeModel: groq/oss
`;

describe('break-primary and restore-primary (Task C)', () => {
  it('detects the format from the file name', () => {
    expect(formatOf('/w/.vscode/settings.json')).toBe('settings');
    expect(formatOf('config/models.yaml')).toBe('yaml');
    expect(formatOf('config/models.json')).toBe('json');
  });

  it('breaks a JSONC settings file, keeps comments, the label and the fallbacks; restores exactly', () => {
    const b = breakPrimaryText(SETTINGS, 'settings', BROKEN);
    expect(b.original).toEqual({ trueforgeModel: 'google-gemini/flash-lite' });
    expect(b.profiles).toBe(2);
    expect(b.text).toContain('// Swage profiles for the demo');
    const broken = readPrimary(b.text, 'settings')?.primary;
    expect(broken).toEqual({
      trueforgeModel: BROKEN,
      label: 'Gemini', // the banner still names the original model
      timeouts: { connectMs: 5000, firstTokenMs: 15000 },
    });
    expect(b.text).toContain('"trueforgeModel": "groq/oss"');
    const r = restorePrimaryText(b.text, 'settings', b.original, BROKEN);
    expect(r.restored).toBe(true);
    expect(readPrimary(r.text, 'settings')?.primary).toEqual(b.original);
    expect(() => breakPrimaryText(b.text, 'settings', BROKEN)).toThrow(/already broken/);
  });

  it('breaks a YAML profiles file through the document, so comments and order survive', () => {
    const b = breakPrimaryText(YAML, 'yaml', 'swage-fake/primary-down');
    expect(b.text).toContain('# comment kept');
    const [primary, fallback] = parseProfilesText(b.text);
    expect(primary).toMatchObject({ trueforgeModel: 'swage-fake/primary-down', label: 'Gemini' });
    expect(primary?.timeouts).toEqual({
      connectMs: 5000,
      firstTokenMs: 15000,
      stallMs: 30000,
      totalMs: 600000,
    });
    expect(fallback?.trueforgeModel).toBe('groq/oss');
    const r = restorePrimaryText(b.text, 'yaml', b.original, 'swage-fake/primary-down');
    expect(parseProfilesText(r.text)[0]).toMatchObject({
      trueforgeModel: 'google-gemini/flash-lite',
      label: 'Gemini',
    });
    expect(readPrimary(r.text, 'yaml')?.primary.timeouts).toEqual(b.original.timeouts);
  });

  it('handles a JSON profiles file and a bare YAML list', () => {
    const json =
      '{"profiles":[{"name":"p","trueforgeModel":"a/b"},{"name":"f","trueforgeModel":"c/d"}]}';
    const b = breakPrimaryText(json, 'json', BROKEN);
    expect(JSON.parse(b.text).profiles[0]).toMatchObject({ trueforgeModel: BROKEN, label: 'A' });
    const bare = breakPrimaryText('- name: p\n  trueforgeModel: a/b\n', 'yaml', BROKEN);
    expect(bare.profiles).toBe(1);
    expect(readPrimary(bare.text, 'yaml')?.primary.trueforgeModel).toBe(BROKEN);
  });

  it('leaves a primary that changed since alone, and refuses files without profiles', () => {
    const r = restorePrimaryText(SETTINGS, 'settings', { trueforgeModel: 'x/y' }, BROKEN);
    expect(r).toEqual({ text: SETTINGS, restored: false });
    expect(() => breakPrimaryText('{ "editor.fontSize": 14 }', 'settings', BROKEN)).toThrow(
      /no model profiles/,
    );
    expect(readPrimary('{ not json', 'settings')).toBeUndefined();
    expect(readPrimary('other: 1', 'yaml')).toBeUndefined();
  });
});
