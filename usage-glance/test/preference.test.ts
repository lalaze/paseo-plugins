import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeaderPreference } from '../client/preference.ts';

function mockRpc(handlers: Record<string, (input: any) => any | Promise<any>>) {
  return async (contract: { name: string }, input: unknown) => {
    const handler = handlers[contract.name];
    assert.ok(handler, contract.name);
    return handler(input);
  };
}

test('header preference loads, saves, and recovers from a write conflict', async () => {
  let stored: { revision: string; values: { providerId: string | null } } = { revision: 'missing', values: { providerId: null } };
  let writes = 0;
  const rpc = mockRpc({
    'settings.header.read': () => ({ status: 'ready', revision: stored.revision, values: stored.values }),
    'settings.header.write': (input: { revision: string; values: { providerId: string | null } }) => {
      writes++;
      if (input.revision !== stored.revision) return { status: 'conflict', error: 'changed' };
      stored = { revision: `r${writes}`, values: input.values };
      return { status: 'saved', revision: stored.revision, values: stored.values };
    },
  });
  const preference = createHeaderPreference(rpc as any);
  await preference.load();
  assert.equal(preference.get(), null);
  await preference.save('kimi');
  assert.equal(preference.get(), 'kimi');
  stored.revision = 'other';
  await preference.save('codex');
  assert.equal(preference.get(), 'codex');
  assert.equal(stored.values.providerId, 'codex');
  assert.ok(writes >= 2);
});

test('a failed save restores the previous header selection', async () => {
  const rpc = mockRpc({
    'settings.header.read': () => ({ status: 'ready', revision: 'r1', values: { providerId: 'kimi' } }),
    'settings.header.write': () => { throw new Error('offline'); },
  });
  const preference = createHeaderPreference(rpc as any);
  await preference.load();
  await preference.save('codex');
  assert.equal(preference.get(), 'kimi');
});
