// Lists the models TrueForge has configured (names only; no keys are read or printed).
import { SwageClient } from '../../src/client/client';

const client = new SwageClient({
  baseUrl: process.env['TRUEFORGE_URL'] ?? 'http://localhost:8790',
});
for (const m of await client.listModels()) console.log(m);
