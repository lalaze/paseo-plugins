import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createTask } from '../shared/machine';
import type { PendingEvent } from '../shared/schema';
import { BridgeStore, dotBridgeDataDir, resolveDataDir } from '../server/store';

const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dot-bridge-store-'));
  scratch.push(dir);
  return dir;
}

function sampleTask() {
  const id = randomUUID();
  return createTask({
    id,
    connectionId: 'a'.repeat(32),
    workspaceId: 'ws-1',
    repository: 'https://github.com/acme/repo.git',
    remoteName: 'origin',
    branch: `dot/${id}`,
    environmentHint: '',
    title: 'T',
    requirement: 'R',
    acceptance: '',
    baseSha: '1'.repeat(40),
    targetBranch: 'main',
    roundId: randomUUID(),
    at: 1000,
  });
}

function sampleEvent(taskId: string): PendingEvent {
  return {
    eventId: randomUUID(),
    name: 'paseo.dot.task_changed',
    connectionId: 'a'.repeat(32),
    subscriptionId: null,
    data: { taskId, roundId: randomUUID(), kind: 'created', messageSeq: 1 },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 1000,
  };
}

/** A pid that has already exited, so the recorded lock owner is provably gone. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return result.pid ?? 0;
}

describe('BridgeStore', () => {
  it('persists a task and its pending event in one atomic unit and recovers after reopen', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir);
    const task = sampleTask();
    await store.mutate(draft => {
      draft.tasks.push(task);
      draft.events.push(sampleEvent(task.id));
      draft.dedup.updateIds['u1'] = { hash: 'hash', response: null, at: 0 };
    });
    await store.dispose();

    const reopened = await BridgeStore.open(dir);
    const state = reopened.read();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, task.id);
    assert.equal(state.events.length, 1);
    assert.equal(state.dedup.updateIds['u1'].hash, 'hash');
    await reopened.dispose();
  });

  it('writes valid JSON to state.json', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir);
    await store.mutate(draft => { draft.tasks.push(sampleTask()); });
    await store.dispose();
    const raw = await readFile(join(dir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: number; tasks: unknown[] };
    assert.equal(parsed.version, 8);
    assert.equal(parsed.tasks.length, 1);
  });

  it('leaves a corrupt file untouched and reports the load error', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'state.json'), '{ not json', 'utf8');
    const store = await BridgeStore.open(dir);
    assert.ok(store.loadError);
    await assert.rejects(() => store.mutate(() => undefined));
    await store.dispose();
    const raw = await readFile(join(dir, 'state.json'), 'utf8');
    assert.equal(raw, '{ not json');
  });

  it('serializes concurrent mutations without losing one', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir);
    const tasks = [sampleTask(), sampleTask(), sampleTask()];
    await Promise.all(tasks.map(task => store.mutate(draft => { draft.tasks.push(task); })));
    assert.equal(store.read().tasks.length, 3);
    await store.dispose();
  });
});

describe('BridgeStore migration', () => {
  it('migrates a version-1 file without dropping tasks, results or update ids', async () => {
    const dir = await tempDir();
    const task = sampleTask();
    const v1 = {
      version: 1,
      connection: null,
      tasks: [
        {
          ...task,
          rounds: [
            {
              ...task.rounds[0],
              result: null,
              // The old shape stored bare results, not {result, verification} pairs.
              resultHistory: [
                { baseSha: '1'.repeat(40), headSha: '2'.repeat(40), branch: task.branch, summary: 'old', checks: [], prUrl: null, reportedAt: 1000, updateId: 'old-u', processedThroughSeq: 1, coversLatest: true },
              ],
            },
          ],
        },
      ],
      events: [],
      dedup: { eventIds: {}, updateIds: { u1: 'hash' }, operations: {}, archive: { 'op-x': { hash: 'h', taskId: null, at: 0 } } },
    };
    await writeFile(join(dir, 'state.json'), JSON.stringify(v1), 'utf8');
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, null);
    const state = store.read();
    assert.equal(state.version, 8);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, task.id);
    assert.equal(state.dedup.updateIds['u1'].hash, 'hash');
    assert.equal(state.tasks[0].rounds[0].resultHistory.length, 1);
    assert.equal(state.tasks[0].rounds[0].resultHistory[0].result.updateId, 'old-u');
    // The old verification could not be reconstructed, so it is marked unverified, not `verified`.
    assert.equal(state.tasks[0].rounds[0].resultHistory[0].verification.status, 'none');
    // The archived operation id is preserved (not dropped) as a non-replayable record, so a replay
    // of that id is refused rather than re-executed as a new operation.
    assert.equal(state.dedup.operations['op-x'].hash, 'h');
    assert.equal(state.dedup.operations['op-x'].receipt, null);
    assert.equal(state.dedup.operations['op-x'].replayable, false);
    assert.equal('archive' in (state.dedup as Record<string, unknown>), false);
    await store.dispose();
    // The original bytes are preserved so a bad migration is recoverable.
    const backup = await readFile(join(dir, 'state.v1.json'), 'utf8');
    assert.equal((JSON.parse(backup) as { version: number }).version, 1);
  });

  it('migrates a version-2 partial result outcome to a safe, replayable-null record', async () => {
    const dir = await tempDir();
    const task = sampleTask();
    const v2 = {
      version: 2,
      connection: null,
      tasks: [task],
      events: [],
      dedup: {
        eventIds: {},
        // Version 2 stored a partial result outcome and a progress outcome.
        updateIds: {
          'u-result': { hash: 'h1', response: JSON.stringify({ coversLatest: true, applied: true }), at: 0 },
          'u-progress': { hash: 'h2', response: JSON.stringify({ applied: false, reason: 'terminal' }), at: 0 },
        },
        operations: {},
      },
    };
    await writeFile(join(dir, 'state.json'), JSON.stringify(v2), 'utf8');
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, null);
    const state = store.read();
    assert.equal(state.version, 8);
    assert.equal(state.tasks.length, 1);
    // The partial result outcome cannot be replayed, so it is dropped (a safe fallback is returned).
    assert.equal(state.dedup.updateIds['u-result'].response, null);
    assert.equal(state.dedup.updateIds['u-result'].hash, 'h1');
    // The progress outcome is still valid and kept as-is.
    assert.equal(state.dedup.updateIds['u-progress'].response, JSON.stringify({ applied: false, reason: 'terminal' }));
    await store.dispose();
  });

  it('stores a large operation receipt and update outcome without a size cap', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir);
    const big = 'x'.repeat(250_000);
    await store.mutate(draft => {
      draft.dedup.operations['op-big'] = { hash: 'h', taskId: null, receipt: JSON.stringify({ patch: big }), replayable: true, at: 0 };
      draft.dedup.updateIds['u-big'] = { hash: 'h', response: JSON.stringify({ verification: { patch: big } }), at: 0 };
    });
    await store.dispose();

    const reopened = await BridgeStore.open(dir);
    assert.equal(reopened.loadError, null);
    assert.ok((reopened.read().dedup.operations['op-big'].receipt ?? '').length > 250_000);
    assert.ok((reopened.read().dedup.updateIds['u-big'].response ?? '').length > 250_000);
    await reopened.dispose();
  });
});

describe('BridgeStore lock ownership', () => {
  it('refuses a lock held by a live process', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${process.pid}:now:token`, 'utf8');
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, 'store-locked');
    await assert.rejects(() => store.mutate(() => undefined), /store-locked/);
    await store.dispose();
  });

  it('refuses a fresh owner-less lock that a concurrent acquire may still be writing', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'state.lock'), { recursive: true });
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, 'store-locked');
    await assert.rejects(() => store.mutate(() => undefined), /store-locked/);
    await store.dispose();
  });

  it('reclaims an old orphan lock with no owner file', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, null);
    await store.mutate(draft => { draft.tasks.push(sampleTask()); });
    assert.equal(store.read().tasks.length, 1);
    await store.dispose();
  });

  it('reclaims a lock whose recorded owner has exited', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${deadPid()}:then:token`, 'utf8');
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, null);
    await store.dispose();
  });

  it('lets exactly one of several concurrent recoverers reclaim a dead-owner lock', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${deadPid()}:then:token`, 'utf8');
    const stores = await Promise.all(Array.from({ length: 8 }, () => BridgeStore.open(dir)));
    const winners = stores.filter(store => store.loadError === null);
    assert.equal(winners.length, 1);
    await Promise.all(stores.map(store => store.dispose()));
  });

  it('recovers when a crashed recoverer left an old empty reclaim ticket', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${deadPid()}:then:token`, 'utf8');
    const ticket = join(dir, 'state.lock.reclaim');
    await writeFile(ticket, '', 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(ticket, past, past);
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, null);
    await store.mutate(draft => { draft.tasks.push(sampleTask()); });
    assert.equal(store.read().tasks.length, 1);
    await store.dispose();
  });

  it('does not steal a dead-owner lock while a fresh reclaim ticket may still be in use', async () => {
    const dir = await tempDir();
    const lock = join(dir, 'state.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `${deadPid()}:then:token`, 'utf8');
    // A fresh, empty ticket could still be a live recoverer filling it in; the lock must not be taken.
    await writeFile(join(dir, 'state.lock.reclaim'), '', 'utf8');
    const store = await BridgeStore.open(dir);
    assert.equal(store.loadError, 'store-locked');
    await store.dispose();
  });
});

describe('data directory resolution', () => {
  it('prefers PASEO_DOT_BRIDGE_DATA_DIR, then PASEO_HOME, and otherwise refuses to guess', () => {
    assert.equal(resolveDataDir({ PASEO_DOT_BRIDGE_DATA_DIR: '/tmp/dot-bridge' }), '/tmp/dot-bridge');
    assert.equal(resolveDataDir({ PASEO_HOME: '/tmp/paseo-home' }), join('/tmp/paseo-home', 'paseo-dot-bridge'));
    assert.equal(resolveDataDir({}), null);
    assert.throws(() => dotBridgeDataDir({}), /data-dir-unset/);
  });
});
