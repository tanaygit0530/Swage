/**
 * npm run restore-primary: undoes npm run break-primary (blueprint section 10, Task C). Puts the
 * saved primary model, label and timers back in every file it changed, unless someone changed
 * that primary since, and removes the temporary TrueForge provider.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { describeError } from '../src/client/client';
import { formatOf, restorePrimaryText } from './lib/primary';
import { clearState, loadState, STATE_FILE } from './lib/primaryState';

const state = loadState();
if (!state) {
  console.log(`Nothing to restore (${STATE_FILE} does not exist).`);
  process.exit(0);
}
let problems = 0;
for (const { file, original } of state.files) {
  if (!existsSync(file)) {
    console.log(`${file}: missing, skipped`);
    problems++;
    continue;
  }
  const r = restorePrimaryText(
    readFileSync(file, 'utf8'),
    formatOf(file),
    original,
    state.brokenModel,
  );
  if (r.restored) {
    writeFileSync(file, r.text);
    console.log(`${file}: primary back to ${original.trueforgeModel}`);
  } else {
    console.log(`${file}: the primary is no longer ${state.brokenModel}; left as it is`);
  }
}
if (state.provider) {
  try {
    await new TrueForge({
      baseUrl: state.baseUrl,
      timeoutInSeconds: 30,
    }).settings.modelProviders.delete(state.provider);
    console.log(`Removed the TrueForge provider ${state.provider}.`);
  } catch (err) {
    console.log(`Could not remove the provider ${state.provider}: ${describeError(err)}`);
    problems++;
  }
}
if (problems === 0) clearState();
else console.log(`Kept ${STATE_FILE}; fix the above and run again.`);
