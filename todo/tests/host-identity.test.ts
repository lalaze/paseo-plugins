import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hostIdentity } from '../server/host-identity';

describe('host identity', () => {
  it('uses PASEO_SERVER_ID, then the daemon server-id file, and the machine name as the label', async () => {
    const home = await mkdtemp(join(tmpdir(), 'todo-home-'));
    try {
      assert.deepEqual(await hostIdentity({ PASEO_SERVER_ID: ' srv-env ' }, home), { id: 'srv-env', label: hostname() });
      assert.equal((await hostIdentity({ PASEO_HOME: home }, home)).id, null);
      await writeFile(join(home, 'server-id'), 'srv-file\n');
      assert.equal((await hostIdentity({ PASEO_HOME: home }, home)).id, 'srv-file');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
