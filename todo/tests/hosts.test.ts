import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHostRegistry, hostLabel } from '../client/hosts';

const rpc = (name: string) => (async () => name) as never;

describe('host registry', () => {
  it('lists a host only once it knows its server id, sorted by label', () => {
    const registry = createHostRegistry();
    const zed = registry.register(rpc('zed'));
    const amy = registry.register(rpc('amy'));
    assert.deepEqual(registry.getSnapshot(), []);
    zed.identify({ id: 'srv-z', label: 'zed' });
    amy.identify({ id: 'srv-a', label: 'amy' });
    assert.deepEqual(registry.getSnapshot().map(host => host.id), ['srv-a', 'srv-z']);
  });

  it('keeps one entry per server id, the latest registration winning, and drops it when that one unloads', () => {
    const registry = createHostRegistry();
    let calls = 0;
    registry.subscribe(() => { calls += 1; });
    const first = registry.register(rpc('old'));
    first.identify({ id: 'srv', label: 'box' });
    const second = registry.register(rpc('new'));
    second.identify({ id: 'srv', label: 'box' });
    assert.equal(registry.getSnapshot().length, 1);
    assert.equal(registry.getSnapshot()[0]?.rpc, second.rpc);
    first.dispose();
    assert.equal(registry.getSnapshot().length, 1, 'an older, replaced registration does not remove the live one');
    second.dispose();
    assert.deepEqual(registry.getSnapshot(), []);
    assert.ok(calls >= 3);
  });

  it('keeps the snapshot identity stable until something changes', () => {
    const registry = createHostRegistry();
    const one = registry.register(rpc('one'));
    one.identify({ id: 'srv', label: 'one' });
    const before = registry.getSnapshot();
    one.identify({ id: 'srv', label: 'one' });
    assert.equal(registry.getSnapshot(), before);
  });

  it('names a host as the app does, falling back to the machine name', () => {
    const app = [{ serverId: 'srv-a', label: 'MacBook', status: 'online' as const }];
    assert.equal(hostLabel({ id: 'srv-a', label: 'amys-mbp.local' }, app), 'MacBook');
    assert.equal(hostLabel({ id: 'srv-b', label: 'code' }, app), 'code');
  });
});
