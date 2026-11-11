import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUEFORGE_SDK_VERSION, TRUEFORGE_VERSION } from '../../../src/supervisor/pin';

describe('pinned TrueForge version', () => {
  it('is the same in start.sh, start.ps1 and pin.ts', () => {
    expect(readFileSync('trueforge/start.sh', 'utf8')).toContain(
      `TRUEFORGE_VERSION="${TRUEFORGE_VERSION}"`,
    );
    expect(readFileSync('trueforge/start.ps1', 'utf8')).toContain(
      `$TrueForgeVersion = '${TRUEFORGE_VERSION}'`,
    );
  });

  it('matches the exact SDK version in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@truefoundry/trueforge-sdk']).toBe(TRUEFORGE_SDK_VERSION);
  });

  it('start.sh keeps SQLite outside the repo and allowlists loopback', () => {
    const sh = readFileSync('trueforge/start.sh', 'utf8');
    expect(sh).toContain(`export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`);
    expect(sh).toContain('SQLITE_PATH must be outside the Swage repository');
    expect(sh).toContain('npx --yes "@truefoundry/trueforge@${TRUEFORGE_VERSION}" --port "$PORT"');
  });
});
