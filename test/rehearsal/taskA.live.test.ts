import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfilesFile } from '../../src/resilience/profiles';
import { rehearseTaskA } from './taskA';

/**
 * Task A on a real TrueForge with a real model (blueprint section 10). Needs SWAGE_LIVE=1,
 * SWAGE_FLASK_DIR and a running TrueForge (trueforge/start.sh); skipped otherwise.
 * SWAGE_PROFILE picks the profile from config/models.yaml or the example (default: the first); SWAGE_MODEL
 * instead uses any TrueForge model FQN, as a profile named "rehearsal".
 * `npm run rehearse:task-a:live` runs it and prints the transcript.
 */
const FLASK = process.env.SWAGE_FLASK_DIR;
const LIVE = process.env.SWAGE_LIVE === '1';

describe.skipIf(!FLASK || !LIVE)('Task A on real TrueForge', () => {
  it('real model: cancel demo, inline edit, review, apply, verification, undo', async () => {
    const { file, profiles } = loadProfilesFile('.');
    const wanted = process.env.SWAGE_PROFILE;
    const model = process.env.SWAGE_MODEL;
    const profile = model
      ? {
          name: 'rehearsal',
          kind: 'hosted' as const,
          trueforgeModel: model,
          params: { temperature: 0, max_tokens: 4096 },
        }
      : wanted
        ? profiles.find((p) => p.name === wanted)
        : profiles[0];
    expect(profile, `profile ${wanted ?? '(first)'} in ${file}`).toBeDefined();
    if (!profile) return;
    const report = await rehearseTaskA(
      path.resolve(FLASK ?? ''),
      (l = '') => void process.stdout.write(`${l}\n`),
      { baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', profile },
    );
    expect(report.a0.outcome).toBe('cancelled: Cancelled. Workspace unchanged.');
    expect(report.a0.status).toBe('');
    expect(report.blocks).toBeGreaterThan(0);
    expect(report.verification).toBe('False');
    expect(report.statusAfterUndo).toBe('');
  }, 300_000);
});
