import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostIdentity } from '../server/host-identity.ts';

test('host identity reads the public daemon id and honors overrides without generating an identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-host-'));
  try {
    assert.equal((await hostIdentity({ PASEO_HOME: root })).id, null);
    await writeFile(join(root, 'server-id'), 'srv_example\n');
    assert.equal((await hostIdentity({ PASEO_HOME: root })).id, 'srv_example');
    assert.equal((await hostIdentity({ PASEO_HOME: root, PASEO_SERVER_ID: 'srv_override' })).id, 'srv_override');
    assert.ok((await hostIdentity({ PASEO_HOME: root })).label.length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
