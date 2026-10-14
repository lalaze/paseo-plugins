// Regression entry point for the historical claim-stall diagnosis.
// Uses synthetic tasks and fake webhooks; no live state or calls are touched.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/claim-recovery.test.ts'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
