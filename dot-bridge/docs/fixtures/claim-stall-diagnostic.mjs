// Diagnostic of the observed behavior, not a regression test of desired behavior.
// Run from dot-bridge: node --import tsx docs/fixtures/claim-stall-diagnostic.mjs
// Uses synthetic tasks, a fake webhook and a temporary store; no live calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeEngine } from '../../server/engine.ts';
import { BridgeStore } from '../../server/store.ts';
import { generateSecret } from '../../server/signing.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dot-claim-diagnostic-'));
  const store = await BridgeStore.open(dir);
  const clock = { value: 1_000_000 };
  const deliveries = [];
  let onTask = async () => {};
  const engine = new BridgeEngine({ store, now: () => clock.value, getMaxInFlight: () => 1,
    allowPrivateCallback: true, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.type === 'verification') return new Response(JSON.stringify({ challenge: body.challenge }));
      deliveries.push(body);
      if (body.name === 'paseo.dot.task_changed') await onTask(body);
      return new Response('');
    } });
  await engine.init();
  engine.setBridgeListening(true);
  const subscription = { name: 'paseo.dot.task_changed', arguments: { connectionId: engine.connection().id },
    delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() }, cursor: null };
  await engine.setSubscription(subscription);
  const { challenge } = await engine.startConnectionTest(randomUUID());
  await engine.confirmConnection(engine.connection().id, challenge);
  const prompt = async (id = randomUUID()) => (await engine.providerPrompt({ id, operationId: randomUUID(),
    clientMessageId: randomUUID(), workspaceId: 'synthetic', cwd: dir, body: 'Synthetic reply request',
    systemPrompt: '', attachments: [] })).task;
  const tick = async () => { await engine.dispatchTick(); await engine.deliverTick(); };
  const close = async () => { engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); };
  return { engine, store, clock, deliveries, subscription, prompt, tick, close, setHandler: fn => { onTask = fn; } };
}

const evidence = {};
const h = await fixture();
try {
  const first = await h.prompt();
  await h.tick();
  const count = h.deliveries.length;
  const second = await h.prompt();
  for (let i = 0; i < 60; i++) { h.clock.value += 60_000; await h.tick(); }
  await h.engine.recover();
  assert.equal(h.engine.task(first.id).status, 'dispatched');
  assert.equal(h.engine.task(first.id).rounds[0].claim, null);
  assert.equal(h.engine.task(second.id).status, 'queued');
  assert.equal(h.deliveries.length - count, 1); // Only the second task's premature notification.
  evidence.noClaimRecovery = { simulatedMinutes: 60, first: 'dispatched, unclaimed', second: 'queued',
    redeliveriesOfFirst: h.deliveries.filter(e => e.data.taskId === first.id).length - 1 };

  await h.engine.claimTask({ connectionId: first.connectionId, taskId: first.id, roundId: first.currentRoundId });
  await h.engine.processResult({ connectionId: first.connectionId, taskId: first.id, roundId: first.currentRoundId,
    updateId: randomUUID(), kind: 'text', baseSha: null, headSha: null, branch: null, prUrl: null,
    summary: 'Synthetic answer', checks: [], processedThroughSeq: first.userMessageSeq });
  await h.engine.cancelRequest({ id: second.id, revision: h.engine.task(second.id).revision, operationId: randomUUID() });
  await h.engine.deliverTick();
  const before = h.store.read().events.length;
  await h.engine.setSubscription(h.subscription);
  const extra = h.store.read().events.slice(before);
  assert.equal(extra.length, 2);
  evidence.subscriptionReplay = extra.map(e => ({ taskStatus: h.engine.task(e.data.taskId).status, kind: e.data.kind }));
} finally { await h.close(); }

const r = await fixture();
try {
  // Complete an initial reply, then reproduce on the same conversation's follow-up.
  const initial = await r.prompt();
  await r.tick();
  await r.engine.claimTask({ connectionId: initial.connectionId, taskId: initial.id, roundId: initial.currentRoundId });
  await r.engine.processResult({ connectionId: initial.connectionId, taskId: initial.id, roundId: initial.currentRoundId,
    updateId: randomUUID(), kind: 'text', baseSha: null, headSha: null, branch: null, prUrl: null,
    summary: 'Initial answer', checks: [], processedThroughSeq: initial.userMessageSeq });
  // A prompt arrives after one tick's dispatch check, before its delivery snapshot.
  await r.engine.dispatchTick();
  const task = await r.prompt(initial.id);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let rejection;
  r.setHandler(async () => {
    try { await r.engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId }); }
    catch (error) { rejection = error.message; }
    entered();
    await gate;
  });
  const delivering = r.engine.deliverTick();
  await ready;
  // Next tick dispatches while the earlier callback is still in flight.
  await r.engine.dispatchTick();
  release();
  await delivering;
  r.setHandler(async () => {});
  await r.tick();
  assert.match(rejection, /claim-rejected\s+queued/);
  assert.equal(r.engine.task(task.id).status, 'dispatched');
  assert.equal(r.engine.task(task.id).rounds.at(-1).claim, null);
  assert.equal(r.deliveries.filter(e => e.data.roundId === task.currentRoundId).length, 1);
  evidence.deliveryDispatchRace = { rejection, finalStatus: 'dispatched, unclaimed', followUpNotifications: 1 };
} finally { await r.close(); }
console.log(JSON.stringify(evidence, null, 2));
