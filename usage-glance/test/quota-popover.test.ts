import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuotaPopoverScope } from '../client/quota-popover.ts';

test('opening quota in another retained workspace closes the previous popup', () => {
  const scope = createQuotaPopoverScope();
  const visible = new Set(['a']);
  const releaseA = scope.open(() => visible.delete('a'));
  visible.add('b');
  const releaseB = scope.open(() => visible.delete('b'));
  assert.deepEqual([...visible], ['b']);
  // The old portal can finish unmounting after the new one has opened.
  releaseA();
  scope.dispose();
  assert.equal(visible.size, 0);
  releaseB();
});

test('independent host/plugin instances share popup ownership', () => {
  const first = createQuotaPopoverScope(), second = createQuotaPopoverScope();
  let firstClosed = 0, secondClosed = 0;
  first.open(() => firstClosed++);
  second.open(() => secondClosed++);
  assert.equal(firstClosed, 1);
  first.dispose();
  assert.equal(secondClosed, 0);
  second.dispose();
  assert.equal(secondClosed, 1);
});

test('ordinary unmount releases ownership without invoking close again', () => {
  const scope = createQuotaPopoverScope();
  let closed = 0;
  const release = scope.open(() => closed++);
  release();
  release();
  scope.dispose();
  assert.equal(closed, 0);
});

test('effect cleanup and remount do not close the remounted popup', () => {
  const scope = createQuotaPopoverScope();
  let closed = 0;
  const release = scope.open(() => closed++);
  release();
  scope.open(() => closed++);
  release();
  assert.equal(closed, 0);
  scope.dispose();
  scope.dispose();
  assert.equal(closed, 1);
});

test('synchronous old-popup cleanup cannot clear the new owner', () => {
  const scope = createQuotaPopoverScope();
  const release = scope.open(() => release());
  let closed = 0;
  scope.open(() => closed++);
  scope.dispose();
  assert.equal(closed, 1);
});

test('late content mounts after plugin disposal are immediately closed', () => {
  const scope = createQuotaPopoverScope();
  scope.dispose();
  let closed = 0;
  scope.open(() => closed++)();
  assert.equal(closed, 1);
});
