import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LatestRequests } from '../client/requests';

it('ignores a slow poll after a mutation refresh, without unlocking that refresh', () => {
  const requests = new LatestRequests();
  const poll = requests.begin('host')!;
  const refresh = requests.begin('host', true)!;
  assert.equal(poll.current(), false);
  poll.finish();
  assert.equal(requests.begin('host'), null);
  assert.equal(refresh.current(), true);
  refresh.finish();
  assert.equal(poll.current(), false, 'late success and failure both remain stale');
  assert.ok(requests.begin('host'));
});

it('invalidates responses on scope change or unmount and keeps hosts independent', () => {
  const requests = new LatestRequests();
  const a = requests.begin('a')!;
  const b = requests.begin('b')!;
  assert.equal(a.current(), true);
  assert.equal(b.current(), true);
  requests.clear();
  const next = requests.begin('a')!;
  a.finish();
  assert.equal(a.current(), false);
  assert.equal(b.current(), false);
  assert.equal(next.current(), true);
  assert.equal(requests.begin('a'), null);
});
