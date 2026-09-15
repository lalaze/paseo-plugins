import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { orderHeaderButtons, transform } = await import(pathToFileURL(join(import.meta.dirname, '../scripts/header-order-patch.mjs')).href);
const entry = (id: string, plugin: string, serverId = 'host', workspaceId = 'workspace', placement = 'header') => ({ id, installation: { id: plugin, serverId }, context: { workspaceId }, placement });
const quota = entry('usage', 'paseo-usage-glance');
const settings = entry('director-settings', 'paseo-director');

test('quota precedes settings in either registration order without mutating entries', () => {
  const other = entry('other', 'other');
  const original = [settings, other, quota];
  const ordered = orderHeaderButtons(original);
  assert.deepEqual(ordered, [other, quota, settings]);
  assert.deepEqual(original, [settings, other, quota]);
  assert.equal(ordered[2], settings);
  assert.deepEqual(orderHeaderButtons(ordered), ordered);
  assert.deepEqual(orderHeaderButtons([quota, settings]), [quota, settings]);
  assert.deepEqual(orderHeaderButtons([settings]), [settings]);
});

test('other hosts, workspaces, plugins and composer pills retain their order', () => {
  for (const unrelated of [
    entry('director-settings', 'paseo-director', 'other-host'),
    entry('director-settings', 'paseo-director', 'host', 'other-workspace'),
    entry('director-settings', 'other-plugin'),
    entry('director-settings', 'paseo-director', 'host', 'workspace', 'composer'),
  ]) assert.deepEqual(orderHeaderButtons([unrelated, quota]), [unrelated, quota]);
});

test('patch is executable, repeatable, reversible and rejects changed anchors', () => {
  const source = 'class Store {addHeaderButton(t,n){return this.add(t,n,"header",{})}publish(t){this.entries=t;for(const t of this.listeners)t()}}';
  const patched = transform(source);
  assert.equal(transform(patched), patched);
  assert.equal(transform(patched, true), source);
  assert.equal(transform(source, true), source);
  assert.throws(() => transform(source + source), /anchor changed/);
  assert.throws(() => transform(source.replace('this.entries=t;', 'this.entries=[...t];')), /anchor changed/);
  const Store = new Function(patched + ';return Store;')();
  const store = new Store();
  let notifications = 0;
  store.listeners = new Set([() => notifications++]);
  store.publish([settings, quota]);
  assert.deepEqual(store.entries, [quota, settings]);
  assert.equal(notifications, 1);
});
