import assert from 'node:assert/strict';
import test from 'node:test';
import { followWorkspaces } from '../client/workspaces.ts';

const page = (ids: string[], nextCursor: string | null = null) => ({ entries: ids.map(id => ({ id, archivingAt: null })), pageInfo: { hasMore: !!nextCursor, nextCursor } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('headers include workspaces without agents and reconcile concurrent archive/create events', async () => {
  let listener: (update: any) => void = () => {};
  let finish: (value: any) => void = () => {};
  let unsubscribed = false;
  let snapshot = new Set<string>();
  const api: any = { workspaces: {
    subscribe(fn: typeof listener) { listener = fn; return () => { unsubscribed = true; }; },
    list(options: any) {
      assert.equal(options.subscribe, undefined);
      if (!options.page.cursor) return Promise.resolve(page(['terminal-only', 'removed'], 'page2'));
      return new Promise(resolve => { finish = resolve; });
    },
  } };
  const stop = followWorkspaces(api, ids => { snapshot = new Set(ids); });
  try {
    await tick();
    listener({ kind: 'remove', id: 'removed' });
    listener({ kind: 'upsert', workspace: { id: 'created', archivingAt: null } });
    finish(page(['files-only']));
    await tick();
    assert.deepEqual([...snapshot].sort(), ['created', 'files-only', 'terminal-only']);
    listener({ kind: 'upsert', workspace: { id: 'created', archivingAt: '2026-09-12' } });
    assert.equal(snapshot.has('created'), false);
  } finally { stop(); }
  assert.equal(unsubscribed, true);
});

test('a workspace response arriving after cleanup cannot recreate headers', async () => {
  let finish: (value: any) => void = () => {};
  let changes = 0;
  const api: any = { workspaces: { subscribe() { return () => {}; }, list() { return new Promise(resolve => { finish = resolve; }); } } };
  const stop = followWorkspaces(api, () => { changes++; });
  stop();
  finish(page(['late']));
  await tick();
  assert.equal(changes, 0);
});
