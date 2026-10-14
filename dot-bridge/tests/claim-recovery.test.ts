import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { generateSecret } from '../server/signing';
import { currentRound, taskSchema, migrateStoreFile } from '../shared/schema';
import { permissionSchema } from '../shared/permissions';
import { claimWaitLabel } from '../shared/claim-recovery';
import { RemoteCenter } from '../server/remote-center';
import { RemoteStateStore } from '../server/remote-state';
import { remoteCall } from '../server/remote-http';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-claim-recovery-'));
  let store = await BridgeStore.open(dir);
  const clock = { value: 1_000_000 };
  const deliveries: Array<{ data: { taskId: string; roundId: string }; eventId: string }> = [];
  let engine!: BridgeEngine;
  let onEvent: () => Promise<Response | void> = async () => {};
  const openEngine = async () => {
    engine = new BridgeEngine({ store, now: () => clock.value, getMaxInFlight: () => 1,
      allowPrivateCallback: true, fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.type === 'verification') return new Response(JSON.stringify({ challenge: body.challenge }));
        deliveries.push(body); return await onEvent() ?? new Response('');
      } });
    await engine.init(); engine.setBridgeListening(true);
  };
  await openEngine();
  t.after(async () => { engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const subscribe = () => engine.setSubscription({ name: 'paseo.dot.task_changed', arguments: { connectionId: engine.connection().id },
    delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() }, cursor: null });
  await subscribe();
  const { challenge } = await engine.startConnectionTest(randomUUID());
  await engine.confirmConnection(engine.connection().id, challenge);
  const prompt = async (id: string = randomUUID()) => (await engine.providerPrompt({ id, operationId: randomUUID(),
    clientMessageId: randomUUID(), workspaceId: 'synthetic', cwd: dir, body: 'Synthetic request', systemPrompt: '', attachments: [] })).task;
  const tick = async () => { await engine.dispatchTick(); await engine.deliverTick(); };
  return { get engine() { return engine; }, get store() { return store; }, clock, deliveries, prompt, tick, subscribe,
    setHandler(fn: () => Promise<Response | void>) { onEvent = fn; },
    async reopen() { engine.dispose(); await store.dispose(); store = await BridgeStore.open(dir); await openEngine(); },
  };
}

test('unclaimed delivery times out, retries with bounded backoff and survives restart', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  const second = await h.prompt();
  const count = () => h.deliveries.filter(e => e.data.taskId === task.id).length;
  assert.equal(count(), 1);
  h.clock.value += 119_999; await h.tick(); assert.equal(count(), 1);
  h.clock.value += 1; await h.tick(); assert.equal(count(), 2);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.timedOut, true);
  await h.reopen();
  for (const delay of [240_000, 480_000]) {
    h.clock.value += delay - 1; await h.tick(); assert.ok(count() < 4);
    h.clock.value++; await Promise.all([h.tick(), h.tick()]);
  }
  assert.equal(count(), 4); assert.equal(new Set(h.deliveries.map(e => e.eventId)).size, 4);
  h.clock.value += 3_600_000; await h.tick(); assert.equal(count(), 4);
  assert.equal(h.engine.task(second.id).status, 'queued');
  assert.equal(h.deliveries.some(e => e.data.taskId === second.id), false);
  const waiting = h.engine.task(task.id);
  await h.engine.rewakeTask({ id: task.id, roundId: task.currentRoundId, revision: waiting.revision, operationId: randomUUID() });
  await h.engine.deliverTick(); assert.equal(count(), 5);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.retries, 3);
  h.clock.value += 3_600_000; await h.tick(); assert.equal(count(), 5);
});

test('manual wake keeps the round, deduplicates a lost response and rejects claimed, stale or stopped rounds', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  const input = () => ({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  await assert.rejects(h.engine.rewakeTask(input()), /wake-cooldown/);
  h.clock.value += 120_000;
  const request = input(); const result = await h.engine.rewakeTask(request);
  assert.equal(result.currentRoundId, task.currentRoundId);
  assert.deepEqual(await h.engine.rewakeTask(request), result);
  await h.engine.deliverTick(); assert.equal(h.deliveries.length, 2);
  await assert.rejects(h.engine.rewakeTask(input()), /wake-cooldown/);
  await assert.rejects(h.engine.rewakeTask({ ...input(), roundId: randomUUID() }), /round-stale/);
  await h.engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
  await assert.rejects(h.engine.rewakeTask(input()), /wake-unavailable/);
  h.clock.value += 3_600_000; await h.tick(); assert.equal(h.deliveries.length, 2);
  const current = h.engine.task(task.id);
  await h.engine.cancelRequest({ id: task.id, revision: current.revision, operationId: randomUUID() });
  await assert.rejects(h.engine.rewakeTask(input()), /wake-unavailable/);
});

test('a queued follow-up cannot be delivered or swallow the dispatch notification', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  await h.engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
  await h.engine.processResult({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId,
    updateId: randomUUID(), kind: 'text', baseSha: null, headSha: null, branch: null, prUrl: null,
    summary: 'Done', checks: [], processedThroughSeq: task.userMessageSeq });
  const next = await h.prompt(task.id);
  await h.engine.deliverTick(); assert.equal(h.deliveries.length, 1);
  h.setHandler(async () => {
    await h.engine.claimTask({ connectionId: next.connectionId, taskId: next.id, roundId: next.currentRoundId });
  });
  await h.tick(); assert.equal(h.engine.task(task.id).status, 'claimed');
  assert.equal(h.deliveries.length, 2);
});

test('pending recovery is suppressed after a claim or stop, and subscription refresh ignores finished work', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  h.clock.value += 120_000;
  await h.engine.rewakeTask({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  await h.engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
  await h.engine.deliverTick(); assert.equal(h.deliveries.length, 1);
  const current = h.engine.task(task.id);
  await h.engine.cancelRequest({ id: task.id, revision: current.revision, operationId: randomUUID() });
  await h.engine.reportProgress({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId,
    updateId: randomUUID(), kind: 'stopped', note: 'Stopped', processedThroughSeq: task.userMessageSeq });
  await h.engine.deliverTick(); const count = h.deliveries.length;
  await h.subscribe(); h.clock.value += 3_600_000; await h.tick(); assert.equal(h.deliveries.length, count);
});

test('v10 upgrade initializes legacy dispatched recovery from delivery', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  const file = h.store.file;
  await h.store.dispose();
  const raw = JSON.parse(await readFile(file, 'utf8')); raw.version = 10;
  delete raw.tasks[0].rounds[0].claimWait;
  await writeFile(file, JSON.stringify(raw));
  await h.reopen();
  assert.equal(h.store.loadError, null);
  h.clock.value += 120_000; await h.tick();
  assert.equal(h.deliveries.length, 2);
});

test('v10 migration preserves existing approval decisions', async t => {
  const h = await fixture(t), task = await h.prompt();
  const permission = permissionSchema.parse({ requestId: randomUUID(), roundId: task.currentRoundId,
    userMessageSeq: task.userMessageSeq, title: 'Read file', description: 'Read requested file',
    scope: { toolName: 'read_dot_file', action: 'read', targets: ['one.ts'] }, status: 'approved',
    requestedAt: h.clock.value, resolvedAt: h.clock.value });
  const raw = { ...h.store.read(), version: 10, tasks: [{ ...task, permissions: [permission] }] };
  const migrated = migrateStoreFile(raw);
  assert.equal(migrated.migrated, true);
  const parsed = taskSchema.parse((migrated.data as typeof raw).tasks[0]);
  assert.deepEqual(parsed.permissions, [permission]);
});

test('stopping an unclaimed round cancels pending reminder and permits a new round', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  h.clock.value += 120_000;
  await h.engine.rewakeTask({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  await h.engine.cancelRequest({ id: task.id, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  const next = await h.prompt(task.id); await h.tick();
  assert.notEqual(next.currentRoundId, task.currentRoundId);
  assert.equal(h.deliveries.filter(e => e.data.roundId === task.currentRoundId).length, 1);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.retries, 0);
});

test('timeout remains visible offline and pending notification prevents reminder pile-up', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  h.engine.setBridgeListening(false); h.clock.value += 120_000; await h.tick();
  const round = currentRound(h.engine.task(task.id));
  assert.equal(round.claimWait?.timedOut, true); assert.equal(h.deliveries.length, 1);
  assert.match(claimWaitLabel(round, 'zh-CN')!, /长时间未领取/);
  assert.match(claimWaitLabel(round, 'en')!, /not claimed/);
  await assert.rejects(h.engine.rewakeTask({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() }), /connection-unverified/);
  h.engine.setBridgeListening(true);
  await h.engine.rewakeTask({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  h.clock.value += 120_000;
  await h.tick(); assert.equal(h.deliveries.length, 2);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.retries, 0);
});

test('failed reminder transport does not erase original delivery or consume multiple reminder slots', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  h.setHandler(async () => new Response('', { status: 500 }));
  h.clock.value += 120_000; await h.tick();
  const eventId = h.deliveries.at(-1)!.eventId;
  h.clock.value += 240_000; await h.tick();
  assert.equal(h.deliveries.at(-1)!.eventId, eventId);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.retries, 1);
  h.setHandler(async () => new Response('', { status: 410 }));
  h.clock.value += 60_000; await h.tick();
  assert.equal(h.engine.task(task.id).messages[0]!.delivery, 'delivered');
  h.setHandler(async () => {}); await h.tick();
  assert.notEqual(h.deliveries.at(-1)!.eventId, eventId);
  assert.equal(currentRound(h.engine.task(task.id)).claimWait?.retries, 2);
});

test('a locally closed predecessor still receives its unacknowledged stop after a new round starts', async t => {
  const h = await fixture(t), task = await h.prompt(); await h.tick();
  await h.engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
  await h.engine.cancelRequest({ id: task.id, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  await h.engine.closeLocal({ id: task.id, roundId: task.currentRoundId, revision: h.engine.task(task.id).revision, operationId: randomUUID() });
  await h.prompt(task.id); await h.tick();
  assert.ok(h.deliveries.some(e => e.data.roundId === task.currentRoundId && 'kind' in e.data && e.data.kind === 'cancel_requested'));
});

test('remote wake is bound to the owning device and replays the same receipt', async t => {
  const h = await fixture(t);
  const state = new RemoteStateStore(join(h.store.dir, 'remote')); await state.load();
  await state.mutate(draft => { draft.config.mode = 'center'; draft.config.port = 0; });
  const center = new RemoteCenter(state, h.engine, async () => {}); await center.start();
  t.after(() => center.stop());
  const capabilities = { chat: true, attachments: false, readFiles: false, writeFiles: false };
  const owner = await center.createDevice({ name: 'owner', workspaceIds: ['ws'], capabilities });
  const other = await center.createDevice({ name: 'other', workspaceIds: ['ws'], capabilities });
  const input = { id: randomUUID(), operationId: randomUUID(), clientMessageId: 'remote', workspaceId: 'ws', cwd: '/remote', body: 'hello', systemPrompt: '', attachments: [] };
  await remoteCall(center.endpoint, owner.token, 'prompt', input); await h.tick(); h.clock.value += 120_000;
  const task = h.engine.task(input.id);
  const wake = { id: task.id, roundId: task.currentRoundId, revision: task.revision, operationId: randomUUID() };
  await assert.rejects(remoteCall(center.endpoint, other.token, 'rewake', wake));
  const result = await remoteCall(center.endpoint, owner.token, 'rewake', wake);
  assert.deepEqual(await remoteCall(center.endpoint, owner.token, 'rewake', wake), result);
  await h.tick(); assert.equal(h.deliveries.length, 2);
});
