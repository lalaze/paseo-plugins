import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { generateSecret, verifyPayload } from '../server/signing';
import { BridgeEngine } from '../server/engine';
import type { GitPort, VerifyInput } from '../server/git';
import type { FetchLike, Lookup } from '../server/http';
import { BridgeStore } from '../server/store';

const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));
async function tempDir(prefix = 'dot-bridge-engine-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);

function fakeGit(overrides: Partial<GitPort> = {}): GitPort {
  return {
    inspectRepository: async () => ({ directory: '/repo', remotes: [{ name: 'origin', url: 'https://github.com/acme/repo.git' }], branch: 'main', head: BASE, dirty: false, unpushed: false }),
    resolveRepository: async directory => directory,
    verifyResult: async (input: VerifyInput) => ({ ok: true, files: ['note.txt'], patch: 'diff --git', truncated: false, branchHead: input.headSha, verifiedAt: 1 }),
    baseReachable: async () => true,
    prMatches: async () => true,
    ...overrides,
  };
}

/** A fetch that answers the protocol verification by echoing the challenge, then returns 200. */
function echoFetch(counter?: { count: number }): FetchLike {
  return async (_url, init) => {
    if (counter) counter.count += 1;
    const body = typeof init.body === 'string' ? init.body : '';
    try {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === 'verification' && typeof parsed.challenge === 'string') {
        return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    } catch {
      /* not a verification body */
    }
    return new Response('', { status: 200 });
  };
}

interface Harness {
  engine: BridgeEngine;
  store: BridgeStore;
  clock: { value: number };
}

async function harness(options: { git?: GitPort; fetch?: FetchLike; max?: number; dir?: string; lookup?: Lookup; allowPrivateCallback?: boolean } = {}): Promise<Harness> {
  const dir = options.dir ?? (await tempDir());
  const store = await BridgeStore.open(dir);
  const clock = { value: 1_000_000 };
  const engine = new BridgeEngine({
    store,
    git: options.git ?? fakeGit(),
    now: () => clock.value,
    fetchImpl: options.fetch ?? echoFetch(),
    getMaxInFlight: () => options.max ?? 2,
    allowPrivateCallback: options.allowPrivateCallback ?? true,
    lookup: options.lookup,
    randomId: () => randomUUID(),
  });
  await engine.init();
  // Dispatch requires the local bridge to be bound; tests stand it in for the real HTTP server.
  engine.setBridgeListening(true);
  return { engine, store, clock };
}

async function subscribe(engine: BridgeEngine, name: 'paseo.dot.task_changed' | 'paseo.dot.connection_test' = 'paseo.dot.task_changed'): Promise<void> {
  await engine.setSubscription({
    name,
    arguments: { connectionId: engine.connection().id },
    delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
    cursor: null,
  });
}

async function subscribeAndVerify(engine: BridgeEngine, clock: { value: number }): Promise<void> {
  await subscribe(engine);
  const { challenge } = await engine.startConnectionTest(randomUUID());
  await engine.confirmConnection(engine.connection().id, challenge);
  clock.value += 10;
}

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    workspaceId: 'ws-1',
    title: 'Task',
    requirement: 'Do the thing',
    acceptance: '',
    repository: 'https://github.com/acme/repo.git',
    remoteName: 'origin',
    baseSha: BASE,
    targetBranch: 'main',
    environmentHint: '',
    ...overrides,
  };
}

/**
 * Rewrites the on-disk store into the version-1 shape for one operation: the record is reduced to a
 * digest in `dedup.archive` and the version is set back to 1, so the next open runs the migration.
 * This reproduces the real version-1 layout (a pruned operation id with no receipt).
 */
async function archiveOperation(dir: string, operationId: string): Promise<void> {
  const file = join(dir, 'state.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    version: number;
    dedup: { operations: Record<string, { hash: string; taskId: string | null; at: number }>; archive?: Record<string, unknown> };
  };
  const record = raw.dedup.operations[operationId];
  raw.version = 1;
  raw.dedup.archive = { [operationId]: { hash: record.hash, taskId: record.taskId, at: record.at } };
  delete raw.dedup.operations[operationId];
  await writeFile(file, JSON.stringify(raw), 'utf8');
}

describe('engine two-way check', () => {
  it('verifies and delivers signed events through OpenAI fake-IP callbacks after DNS changes', async () => {
    const calls: Array<{ body: string; headers: Headers }> = [];
    let addresses = ['198.18.0.20'];
    const echo = echoFetch();
    const { engine, store, clock } = await harness({
      allowPrivateCallback: false,
      lookup: async () => addresses,
      fetch: async (url, init) => {
        calls.push({ body: String(init.body), headers: new Headers(init.headers) });
        return echo(url, init);
      },
    });
    const secret = generateSecret();
    await engine.setSubscription({
      name: 'paseo.dot.task_changed', arguments: { connectionId: engine.connection().id },
      delivery: { mode: 'webhook', url: 'https://connectors.api.openai.com/hook', secret }, cursor: null,
    });
    assert.equal(engine.connectionFacts().callbackVerified, true);
    assert.equal(JSON.parse(calls[0].body).type, 'verification');
    // An existing subscription must also keep working when the proxy changes its DNS mapping.
    addresses = ['198.19.0.42'];
    const task = await engine.createTask({ ...taskInput(), mode: 'text', repository: null, remoteName: null, baseSha: null, targetBranch: null });
    await engine.deliverTick();
    assert.equal(engine.task(task.id).messages[0].delivery, 'delivered');
    const event = calls.find(call => JSON.parse(call.body).name === 'paseo.dot.task_changed');
    assert.ok(event);
    assert.equal(verifyPayload(secret, {
      id: event.headers.get('webhook-id')!, timestamp: event.headers.get('webhook-timestamp')!,
      signature: event.headers.get('webhook-signature')!,
    }, event.body, clock.value / 1000), true);
    const delivered = store.read().events.find(event => event.data.taskId === task.id);
    assert.equal(delivered?.status, 'delivered');
    // The exception must not allow the same trusted hostname to rebind to a real local service.
    addresses = ['127.0.0.1'];
    const blocked = await engine.createTask({ ...taskInput(), mode: 'text', repository: null, remoteName: null, baseSha: null, targetBranch: null });
    const sent = calls.length;
    await engine.deliverTick();
    assert.equal(calls.length, sent);
    assert.equal(engine.task(blocked.id).messages[0].deliveryError, 'callback-invalid: private-address');
    const blockedEvent = store.read().events.find(event => event.data.taskId === blocked.id);
    assert.equal(blockedEvent?.status, 'failed');
    // Recover the same never-sent event once the callback resolves to an allowed fake IP again.
    addresses = ['198.18.0.20'];
    await engine.deliverTick();
    assert.equal(engine.task(blocked.id).messages[0].delivery, 'delivered');
    assert.equal(store.read().events.find(event => event.eventId === blockedEvent?.eventId)?.status, 'delivered');
    const recovered = calls.find(call => JSON.parse(call.body).eventId === blockedEvent?.eventId);
    assert.ok(recovered);
    const afterRecovery = calls.length;
    await engine.deliverTick();
    assert.equal(calls.length, afterRecovery);
  });

  it('verifies the callback at subscribe time, then withholds dispatch until the dot confirms', async () => {
    const { engine } = await harness();
    assert.equal(engine.readyToDispatch(), false);
    await subscribe(engine);
    // The protocol verification echoed the challenge, so the callback is verified.
    assert.equal(engine.connectionFacts().callbackVerified, true);
    assert.equal(engine.readyToDispatch(), false);
    const task = await engine.createTask(taskInput());
    await engine.deliverTick();
    assert.equal(engine.task(task.id).messages[0].delivery, 'delivered');
    const { challenge } = await engine.startConnectionTest(randomUUID());
    await engine.confirmConnection(engine.connection().id, challenge);
    assert.equal(engine.readyToDispatch(), true);
    const dispatched = await engine.dispatchTick();
    assert.deepEqual(dispatched, [task.id]);
  });

  it('rejects a subscription whose callback does not echo the challenge', async () => {
    const { engine } = await harness({ fetch: async () => new Response('', { status: 200 }) });
    await assert.rejects(
      () => subscribe(engine),
      /callback-verification-failed/,
    );
    assert.equal(engine.connectionFacts().callbackVerified, false);
  });

  it('marks a user message delivered once its event reaches the callback', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    assert.equal(engine.task(task.id).messages[0].delivery, 'pending');
    await engine.deliverTick();
    assert.equal(engine.task(task.id).messages[0].delivery, 'delivered');
  });

  it('rejects a reused or expired challenge', async () => {
    const { engine, clock } = await harness();
    await subscribe(engine);
    const { challenge } = await engine.startConnectionTest(randomUUID());
    await engine.confirmConnection(engine.connection().id, challenge);
    await assert.rejects(() => engine.confirmConnection(engine.connection().id, challenge), /challenge-expired/);
    const second = await engine.startConnectionTest(randomUUID());
    clock.value += 11 * 60 * 1000;
    await assert.rejects(() => engine.confirmConnection(engine.connection().id, second.challenge), /challenge-expired/);
  });

  it('reports a connection test as delivered only for its own event', async () => {
    const { engine } = await harness();
    await subscribe(engine, 'paseo.dot.connection_test');
    const result = await engine.startConnectionTest(randomUUID());
    assert.equal(engine.eventDelivered(result.eventId), false);
    await engine.deliverTick();
    assert.equal(engine.eventDelivered(result.eventId), true);
  });

  it('keeps the connection as the single source of truth for name and tunnel base, allowing a clear', async () => {
    const { engine } = await harness();
    const before = engine.connection();
    const saved = await engine.configureConnection({ operationId: randomUUID(), revision: before.revision, name: 'My ChatGPT dot', publicBaseUrl: 'https://tunnel.example.com' });
    assert.equal(saved.name, 'My ChatGPT dot');
    assert.equal(saved.callbackBaseUrl, 'https://tunnel.example.com');
    assert.equal(saved.revision, before.revision + 1);
    // An empty tunnel base is an explicit clear, not silently ignored.
    const cleared = await engine.configureConnection({ operationId: randomUUID(), revision: saved.revision, name: 'My ChatGPT dot', publicBaseUrl: '' });
    assert.equal(cleared.callbackBaseUrl, '');
  });

  it('returns refreshBefore equal to the granted expiry, consistent with expiresAt', async () => {
    const { engine, clock } = await harness();
    const result = await engine.setSubscription({
      name: 'paseo.dot.task_changed',
      arguments: { connectionId: engine.connection().id },
      delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
      cursor: null,
      ttlMs: 60_000,
    });
    assert.equal(result.refreshBefore, new Date(clock.value + 60_000).toISOString());
    assert.equal(result.cursor, null);
    assert.equal(engine.connection().subscriptions[0].expiresAt, clock.value + 60_000);
  });

  it('does not re-challenge a callback that already passed verification with the same URL and secret', async () => {
    let calls = 0;
    const fetch: FetchLike = async (_url, init) => {
      calls += 1;
      const body = typeof init.body === 'string' ? init.body : '';
      const parsed = JSON.parse(body) as { challenge?: string };
      return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
    };
    const { engine } = await harness({ fetch });
    const secret = generateSecret();
    const base = { name: 'paseo.dot.task_changed' as const, arguments: { connectionId: engine.connection().id }, delivery: { mode: 'webhook' as const, url: 'https://example.com/hook', secret }, cursor: null };
    await engine.setSubscription(base);
    const afterFirst = calls;
    await engine.setSubscription(base);
    assert.equal(calls, afterFirst);
  });
});

describe('engine queue and results', () => {
  it('dispatches two tasks and queues the third', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const first = await engine.createTask(taskInput({ title: 'one' }));
    clock.value += 1;
    const second = await engine.createTask(taskInput({ title: 'two' }));
    clock.value += 1;
    const third = await engine.createTask(taskInput({ title: 'three' }));
    const dispatched = await engine.dispatchTick();
    assert.equal(dispatched.length, 2);
    assert.ok(dispatched.includes(first.id) && dispatched.includes(second.id));
    assert.equal(engine.slotsUsed(), 2);
    assert.equal(engine.summarize(engine.task(third.id)).status, 'queued');
  });

  it('claims idempotently, accepts a result and verifies the commit', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    const claim = await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    assert.equal(claim.created, true);
    const again = await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    assert.equal(again.created, false);

    const outcome = await engine.processResult({
      connectionId: engine.connection().id,
      taskId: task.id,
      roundId: round.roundId,
      updateId: 'u-1',
      baseSha: BASE,
      headSha: HEAD,
      branch: task.branch,
      summary: 'done',
      checks: [{ command: 'npm test', result: 'pass', passed: true }],
      prUrl: null,
      processedThroughSeq: 1,
    });
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.reason, 'ok');
    assert.equal(outcome.verification.status, 'verified');
    assert.equal(outcome.verification.updateId, 'u-1');
    assert.equal(engine.task(task.id).rounds[0].remoteStatus, 'completed');
    assert.equal(engine.slotsUsed(), 0);
  });

  it('refuses progress and results before a claim', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await assert.rejects(
      () => engine.reportProgress({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-pre', kind: 'running', note: '', processedThroughSeq: 1 }),
      /claim-required/,
    );
    assert.equal(engine.slotsUsed(), 1);
  });

  it('returns the same result for a duplicate updateId and rejects a conflicting one', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const payload = {
      connectionId: engine.connection().id,
      taskId: task.id,
      roundId: round.roundId,
      updateId: 'u-dup',
      baseSha: BASE,
      headSha: HEAD,
      branch: task.branch,
      summary: 'done',
      checks: [],
      prUrl: null,
      processedThroughSeq: 1,
    };
    const first = await engine.processResult(payload);
    assert.equal(first.duplicate, false);
    const duplicate = await engine.processResult(payload);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.reason, 'duplicate');
    await assert.rejects(() => engine.processResult({ ...payload, summary: 'different' }), /duplicate-mismatch/);
  });

  it('rejects a result whose base is not the round baseline', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await assert.rejects(
      () => engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-x', baseSha: '9'.repeat(40), headSha: HEAD, branch: task.branch, summary: '', checks: [], prUrl: null, processedThroughSeq: 1 }),
      /base-mismatch/,
    );
  });

  it('records a failed verification without releasing the result', async () => {
    const git = fakeGit({ verifyResult: async () => ({ ok: false, code: 'branch-moved', detail: 'moved' }) });
    const { engine } = await harness({ git });
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const outcome = await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-f', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 's', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(outcome.verification.status, 'failed');
    assert.equal(engine.task(task.id).rounds[0].result !== null, true);
  });

  it('recomputes coverage when a new user message arrives after a result', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-c', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(engine.task(task.id).rounds[0].result?.coversLatest, true);
    clock.value += 5;
    await engine.addMessage({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID(), body: 'one more thing', kind: 'requirement' });
    assert.equal(engine.task(task.id).rounds[0].result?.coversLatest, false);
    assert.equal(engine.task(task.id).userMessageSeq, 2);
  });
});

describe('engine operation idempotency', () => {
  it('returns the stored task for a replayed create, and rejects a conflicting reuse', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const operationId = randomUUID();
    const first = await engine.createTask(taskInput({ operationId, title: 'once' }));
    const replay = await engine.createTask(taskInput({ operationId, title: 'once' }));
    assert.equal(replay.id, first.id);
    assert.equal(engine.tasks().length, 1);
    await assert.rejects(() => engine.createTask(taskInput({ operationId, title: 'different' })), /duplicate-mismatch/);
  });

  it('returns the stored task for a replayed message add', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    const operationId = randomUUID();
    const revision = engine.task(task.id).revision;
    const first = await engine.addMessage({ id: task.id, revision, operationId, body: 'more', kind: 'requirement' });
    const replay = await engine.addMessage({ id: task.id, revision, operationId, body: 'more', kind: 'requirement' });
    assert.equal(replay.messageSeq, first.messageSeq);
    assert.equal(engine.task(task.id).messages.filter(message => message.author === 'user').length, 2);
  });

  it('returns the exact original snapshot for a replayed operation, even after later changes', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    const operationId = randomUUID();
    const revision = engine.task(task.id).revision;
    const first = await engine.addMessage({ id: task.id, revision, operationId, body: 'more', kind: 'requirement' });
    // A later mutation changes the live task; the replay must not reflect it.
    await engine.addMessage({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID(), body: 'and another', kind: 'requirement' });
    const replay = await engine.addMessage({ id: task.id, revision, operationId, body: 'more', kind: 'requirement' });
    assert.deepEqual(replay, first);
    assert.notEqual(engine.task(task.id).revision, first.revision);
  });

  it('runs git once for a replayed result refresh and returns the same receipt', async () => {
    let calls = 0;
    const git = fakeGit({
      verifyResult: async input => {
        calls += 1;
        return { ok: true, files: [], patch: '', truncated: false, branchHead: input.headSha, verifiedAt: 1 };
      },
    });
    const { engine } = await harness({ git });
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-r', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    const operationId = randomUUID();
    const revision = engine.task(task.id).revision;
    const first = await engine.refreshResult({ operationId, id: task.id, revision });
    const callsAfterFirst = calls;
    const replay = await engine.refreshResult({ operationId, id: task.id, revision });
    assert.equal(calls, callsAfterFirst);
    assert.deepEqual(replay.rounds[0].verification, first.rounds[0].verification);
    await assert.rejects(() => engine.refreshResult({ operationId, id: task.id, revision: revision + 1 }), /duplicate-mismatch/);
  });

  it('returns the same challenge for a replayed connection test after it was consumed', async () => {
    const { engine } = await harness();
    await subscribe(engine);
    const operationId = randomUUID();
    const first = await engine.startConnectionTest(operationId);
    await engine.confirmConnection(engine.connection().id, first.challenge);
    const replay = await engine.startConnectionTest(operationId);
    assert.equal(replay.challenge, first.challenge);
    assert.equal(replay.eventId, first.eventId);
  });

  it('validates a result against the round it names, not the current round', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round1 = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId, updateId: 'u-a', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    await engine.createRound({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID() });
    // A late result for round 1 is judged against round 1's base, so it is stored, not a base mismatch.
    const late = await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId, updateId: 'u-b', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'late', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(late.accepted, true);
    assert.equal(late.reason, 'stale-round');
  });
});

describe('engine dispatch readiness', () => {
  it('does not dispatch without a verified task_changed route', async () => {
    const { engine } = await harness();
    await engine.setSubscription({
      name: 'paseo.dot.connection_test',
      arguments: { connectionId: engine.connection().id },
      delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
      cursor: null,
    });
    const { challenge } = await engine.startConnectionTest(randomUUID());
    await engine.confirmConnection(engine.connection().id, challenge);
    assert.equal(engine.connectionFacts().taskRoute, false);
    assert.equal(engine.connectionFacts().ready, false);
    assert.equal(engine.readyToDispatch(), false);
    const task = await engine.createTask(taskInput());
    assert.deepEqual(await engine.dispatchTick(), []);
    assert.equal(engine.summarize(engine.task(task.id)).status, 'queued');
  });

  it('does not dispatch while the local bridge is down', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    engine.setBridgeListening(false);
    assert.equal(engine.readyToDispatch(), false);
    assert.deepEqual(await engine.dispatchTick(), []);
    assert.equal(engine.summarize(engine.task(task.id)).status, 'queued');
  });
});

describe('engine recovery and dedup across restart', () => {
  it('recovers old stop requests for unclaimed tasks and dispatches the waiting message', async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    await subscribeAndVerify(first.engine, first.clock);
    const one = await first.engine.createTask(taskInput({ title: 'one' }));
    const two = await first.engine.createTask(taskInput({ title: 'two' }));
    await first.engine.dispatchTick();
    const waiting = await first.engine.createTask(taskInput({ title: 'waiting' }));
    // Reproduce the old persisted state: stop requested, never claimed, still holding both slots.
    await first.store.mutate(draft => {
      for (const task of draft.tasks.filter(task => task.id === one.id || task.id === two.id)) {
        const round = task.rounds.find(round => round.roundId === task.currentRoundId)!;
        round.stop.requested = true;
        round.stop.at = first.clock.value;
      }
    });
    assert.equal(first.engine.slotsUsed(), 2);
    assert.deepEqual(await first.engine.dispatchTick(), []);
    first.engine.dispose(); await first.store.dispose();
    const second = await harness({ dir });
    await second.engine.recover();
    assert.equal(second.engine.task(one.id).status, 'stopped');
    assert.equal(second.engine.task(two.id).status, 'stopped');
    assert.equal(second.engine.slotsUsed(), 0);
    assert.deepEqual(await second.engine.dispatchTick(), [waiting.id]);
    await assert.rejects(second.engine.claimTask({ taskId: one.id, roundId: one.currentRoundId, connectionId: one.connectionId }), /claim-rejected/);
    assert.equal(second.engine.task(one.id).rounds[0].stop.reported, false);
    assert.equal(second.engine.slotsUsed(), 1);
    second.engine.dispose(); await second.store.dispose();
  });

  it('keeps an in-flight task as it was and does not duplicate it', async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    await subscribeAndVerify(first.engine, first.clock);
    const task = await first.engine.createTask(taskInput());
    await first.engine.dispatchTick();
    assert.equal(first.engine.slotsUsed(), 1);
    await first.store.dispose();

    const second = await harness({ dir });
    assert.equal(second.engine.tasks().length, 1);
    assert.equal(second.engine.summarize(second.engine.task(task.id)).status, 'dispatched');
    await second.engine.recover();
    assert.equal(second.engine.tasks().length, 1);
    assert.equal(second.engine.slotsUsed(), 1);
  });
});

describe('engine local cancel', () => {
  it('serializes cancel-before-claim and claim-before-cancel without orphaning a slot', async () => {
    const { engine, clock, store } = await harness();
    await subscribeAndVerify(engine, clock);
    const canceledFirst = await engine.createTask(taskInput());
    await engine.dispatchTick();
    await engine.cancelRequest({ id: canceledFirst.id, revision: engine.task(canceledFirst.id).revision, operationId: randomUUID() });
    await assert.rejects(engine.claimTask({ taskId: canceledFirst.id, roundId: canceledFirst.currentRoundId, connectionId: canceledFirst.connectionId }), /claim-rejected/);
    assert.equal(engine.slotsUsed(), 0);
    const claimedFirst = await engine.createTask(taskInput());
    await engine.dispatchTick();
    await engine.claimTask({ taskId: claimedFirst.id, roundId: claimedFirst.currentRoundId, connectionId: claimedFirst.connectionId });
    await engine.cancelRequest({ id: claimedFirst.id, revision: engine.task(claimedFirst.id).revision, operationId: randomUUID() });
    await engine.recover();
    assert.equal(engine.task(claimedFirst.id).status, 'claimed');
    assert.equal(engine.slotsUsed(), 1);
    await engine.reportProgress({ taskId: claimedFirst.id, roundId: claimedFirst.currentRoundId, connectionId: claimedFirst.connectionId,
      updateId: randomUUID(), kind: 'stopped', note: 'Stopped', processedThroughSeq: 1 });
    assert.equal(engine.slotsUsed(), 0);
    engine.dispose(); await store.dispose();
  });

  it('cancels a queued third task locally', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    await engine.createTask(taskInput({ title: 'one' }));
    clock.value += 1;
    await engine.createTask(taskInput({ title: 'two' }));
    clock.value += 1;
    const third = await engine.createTask(taskInput({ title: 'three' }));
    await engine.dispatchTick();
    assert.equal(engine.summarize(engine.task(third.id)).status, 'queued');
    const canceled = await engine.cancelRequest({ id: third.id, revision: engine.task(third.id).revision, operationId: randomUUID() });
    assert.equal(canceled.cancelRequested, true);
    assert.equal(engine.summarize(engine.task(third.id)).status, 'stopped');
  });
});

describe('engine dispatch re-validation', () => {
  it('does not dispatch when the verified route is revoked during the async Git check', async () => {
    let engineRef: BridgeEngine | null = null;
    const git = fakeGit({
      baseReachable: async () => {
        if (engineRef) {
          await engineRef.unsubscribe({
            name: 'paseo.dot.task_changed',
            arguments: { connectionId: engineRef.connection().id },
            delivery: { mode: 'webhook', url: 'https://example.com/hook' },
          });
        }
        return true;
      },
    });
    const { engine, clock } = await harness({ git });
    engineRef = engine;
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    assert.deepEqual(await engine.dispatchTick(), []);
    assert.equal(engine.summarize(engine.task(task.id)).status, 'queued');
  });

  it('re-reads the in-flight cap inside the commit, so lowering it cannot over-dispatch', async () => {
    let max = 2;
    let engineRef: BridgeEngine | null = null;
    const git = fakeGit({
      baseReachable: async () => {
        if (engineRef) max = 1; // the cap is lowered while the Git check runs
        return true;
      },
    });
    const store = await BridgeStore.open(await tempDir());
    const clock = { value: 1_000_000 };
    const engine = new BridgeEngine({
      store,
      git,
      now: () => clock.value,
      fetchImpl: echoFetch(),
      getMaxInFlight: () => max,
      allowPrivateCallback: true,
      randomId: () => randomUUID(),
    });
    engineRef = engine;
    await engine.init();
    engine.setBridgeListening(true);
    await subscribeAndVerify(engine, clock);
    await engine.createTask(taskInput({ title: 'one' }));
    clock.value += 1;
    await engine.createTask(taskInput({ title: 'two' }));
    const dispatched = await engine.dispatchTick();
    assert.equal(dispatched.length, 1);
    assert.equal(engine.slotsUsed(), 1);
  });

  it('keeps an unreachable base queued with a visible reason and dispatches once it becomes reachable', async () => {
    let reachable = false;
    const git = fakeGit({ baseReachable: async () => reachable });
    const { engine, clock } = await harness({ git });
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    assert.deepEqual(await engine.dispatchTick(), []);
    assert.equal(engine.summarize(engine.task(task.id)).waitingReason, 'base-unreachable');
    reachable = true;
    // The recheck window has elapsed, so the base is probed again.
    clock.value += 31_000;
    assert.deepEqual(await engine.dispatchTick(), [task.id]);
    assert.equal(engine.summarize(engine.task(task.id)).waitingReason, null);
  });

  it('dispatches a reachable task behind an unreachable one under maxInFlight=1', async () => {
    const unreachableBase = '9'.repeat(40);
    const git = fakeGit({ baseReachable: async (_remote, sha) => sha !== unreachableBase });
    const store = await BridgeStore.open(await tempDir());
    const clock = { value: 1_000_000 };
    const engine = new BridgeEngine({
      store,
      git,
      now: () => clock.value,
      fetchImpl: echoFetch(),
      getMaxInFlight: () => 1,
      allowPrivateCallback: true,
      randomId: () => randomUUID(),
    });
    await engine.init();
    engine.setBridgeListening(true);
    await subscribeAndVerify(engine, clock);
    const old = await engine.createTask(taskInput({ title: 'old', baseSha: unreachableBase }));
    clock.value += 1;
    const fresh = await engine.createTask(taskInput({ title: 'fresh' }));
    const dispatched = await engine.dispatchTick();
    // The reachable task behind the unreachable one must still be dispatched.
    assert.deepEqual(dispatched, [fresh.id]);
    assert.equal(engine.summarize(engine.task(old.id)).status, 'queued');
    assert.equal(engine.summarize(engine.task(old.id)).waitingReason, 'base-unreachable');
  });
});

describe('engine idempotency hardening', () => {
  it('returns the original challenge for an A/B/A connection-test replay', async () => {
    const { engine } = await harness();
    await subscribe(engine, 'paseo.dot.connection_test');
    const a = randomUUID();
    const b = randomUUID();
    const first = await engine.startConnectionTest(a);
    const second = await engine.startConnectionTest(b);
    assert.notEqual(first.challenge, second.challenge);
    const replay = await engine.startConnectionTest(a);
    assert.equal(replay.challenge, first.challenge);
    assert.equal(replay.eventId, first.eventId);
  });

  it('returns the stored claim when a claim is retried after the round reached a terminal state', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    const claim = await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-term', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(engine.task(task.id).rounds[0].remoteStatus, 'completed');
    const replay = await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    assert.equal(replay.created, false);
    assert.equal(replay.claimedAt, claim.claimedAt);
    assert.equal(replay.taskId, claim.taskId);
  });

  it('remembers an operation id across many unrelated operations instead of forgetting it', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const first = randomUUID();
    const created = await engine.createTask(taskInput({ operationId: first, title: 'once' }));
    // Far more than the old receipt cap; the create id must still resolve to its original response.
    for (let index = 0; index < 130; index += 1) {
      clock.value += 1;
      await engine.configureConnection({ operationId: randomUUID(), revision: engine.connection().revision, name: `n${index}`, publicBaseUrl: '' });
    }
    const replay = await engine.createTask(taskInput({ operationId: first, title: 'once' }));
    assert.equal(replay.id, created.id);
    assert.equal(engine.tasks().length, 1);
  });

  it('replays a refresh after many unrelated operations without re-running Git', async () => {
    let calls = 0;
    const git = fakeGit({
      verifyResult: async input => {
        calls += 1;
        return { ok: true, files: [], patch: '', truncated: false, branchHead: input.headSha, verifiedAt: 1 };
      },
    });
    const { engine, clock } = await harness({ git });
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-rr', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    const operationId = randomUUID();
    const revision = engine.task(task.id).revision;
    await engine.refreshResult({ operationId, id: task.id, revision });
    const callsAfterFirst = calls;
    for (let index = 0; index < 130; index += 1) {
      clock.value += 1;
      await engine.configureConnection({ operationId: randomUUID(), revision: engine.connection().revision, name: `n${index}`, publicBaseUrl: '' });
    }
    const replay = await engine.refreshResult({ operationId, id: task.id, revision });
    assert.equal(calls, callsAfterFirst);
    assert.ok(replay.rounds.length >= 1);
  });

  it('returns the original outcome for a replayed history-only progress report', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-done', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    const first = await engine.reportProgress({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-late', kind: 'running', note: 'still going', processedThroughSeq: 1 });
    assert.equal(first.applied, false);
    assert.equal(first.reason, 'terminal');
    const replay = await engine.reportProgress({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-late', kind: 'running', note: 'still going', processedThroughSeq: 1 });
    // The replay returns the ORIGINAL applied/reason, not a later status.
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, 'terminal');
    assert.equal(replay.duplicate, true);
  });
});

describe('engine round history and retry', () => {
  it('resets an old round verification when a late report changes its head, keeping the snapshot', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round1 = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId });
    await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId, updateId: 'u-a', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(engine.task(task.id).rounds[0].verification.status, 'verified');
    await engine.createRound({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID() });
    const late = await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round1.roundId, updateId: 'u-b', baseSha: BASE, headSha: '3'.repeat(40), branch: task.branch, summary: 'late', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(late.reason, 'stale-round');
    const old = engine.task(task.id).rounds[0];
    assert.equal(old.result?.updateId, 'u-b');
    assert.notEqual(old.verification.status, 'verified');
    assert.equal(old.resultHistory.length, 1);
    assert.equal(old.resultHistory[0].result.updateId, 'u-a');
    assert.equal(old.resultHistory[0].verification.status, 'verified');
  });

  it('retries a failed round with a new roundId, keeping the same branch and base', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    await engine.reportProgress({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-fail', kind: 'failed', note: 'quota', processedThroughSeq: 1 });
    assert.equal(engine.task(task.id).rounds[0].remoteStatus, 'failed');
    const retried = await engine.retryRound({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID() });
    assert.notEqual(retried.currentRoundId, round.roundId);
    assert.equal(retried.branch, task.branch);
    const newRound = retried.rounds.find(item => item.roundId === retried.currentRoundId)!;
    assert.equal(newRound.baseSha, BASE);
    assert.equal(newRound.remoteStatus, 'queued');
    // The failed attempt is preserved as its own round.
    assert.equal(retried.rounds.find(item => item.roundId === round.roundId)!.remoteStatus, 'failed');
  });

  it('does not let a late report from the previous attempt close the retried round', async () => {
    const { engine } = await harness();
    await subscribeAndVerify(engine, { value: 0 });
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const oldRound = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: oldRound.roundId });
    await engine.reportProgress({ connectionId: engine.connection().id, taskId: task.id, roundId: oldRound.roundId, updateId: 'u-fail', kind: 'failed', note: 'quota', processedThroughSeq: 1 });
    await engine.retryRound({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID() });
    // Dispatch and re-claim the NEW round.
    await engine.dispatchTick();
    const newRoundId = engine.task(task.id).currentRoundId;
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: newRoundId });
    assert.equal(engine.slotsUsed(), 1);
    // A late result naming the OLD round must not complete the new work or release its slot.
    const late = await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: oldRound.roundId, updateId: 'u-late', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'stale', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(late.reason, 'stale-round');
    const after = engine.task(task.id);
    assert.equal(after.currentRoundId, newRoundId);
    assert.equal(after.rounds.find(item => item.roundId === newRoundId)!.result, null);
    assert.equal(after.rounds.find(item => item.roundId === newRoundId)!.remoteStatus, 'claimed');
    assert.equal(engine.slotsUsed(), 1);
  });

  it('re-dispatches a locally canceled queued task after an explicit retry', async () => {
    const { engine, clock } = await harness({ max: 2 });
    await subscribeAndVerify(engine, clock);
    await engine.createTask(taskInput({ title: 'in flight' }));
    await engine.dispatchTick(); // one slot used, one free
    const queued = await engine.createTask(taskInput({ title: 'queued' }));
    clock.value += 1;
    await engine.cancelRequest({ id: queued.id, revision: engine.task(queued.id).revision, operationId: randomUUID() });
    assert.equal(engine.task(queued.id).cancelRequested, true);
    assert.equal(engine.summarize(engine.task(queued.id)).status, 'stopped');
    const retried = await engine.retryRound({ id: queued.id, revision: engine.task(queued.id).revision, operationId: randomUUID() });
    assert.equal(retried.cancelRequested, false);
    assert.equal(engine.summarize(engine.task(queued.id)).status, 'queued');
    const dispatched = await engine.dispatchTick();
    assert.ok(dispatched.includes(queued.id));
  });
});

describe('engine archived operation replay', () => {
  it('refuses to replay a migrated create id instead of creating a second task', async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    const operationId = randomUUID();
    const input = taskInput({ operationId, title: 'once' });
    const created = await first.engine.createTask(input);
    assert.equal(first.engine.tasks().length, 1);
    await first.store.dispose();
    // Reproduce the real version-1 layout: the create id survives only as an archive digest.
    await archiveOperation(dir, operationId);

    const second = await harness({ dir });
    assert.equal(second.engine.tasks().length, 1);
    // Same content: refused as an archived operation, NOT re-executed into a second task (the 1→2
    // counterexample must stay at 1).
    await assert.rejects(() => second.engine.createTask(input), /operation-archived/);
    assert.equal(second.engine.tasks().length, 1);
    assert.equal(second.engine.task(created.id).id, created.id);
    // Different content: refused as a content mismatch.
    await assert.rejects(() => second.engine.createTask({ ...input, title: 'different' }), /duplicate-mismatch/);
    assert.equal(second.engine.tasks().length, 1);
    // The identity is still persisted, marked non-replayable, and the backup is kept.
    const migrated = second.store.read().dedup.operations[operationId];
    assert.equal(migrated.replayable, false);
    assert.equal(migrated.receipt, null);
    assert.equal(migrated.taskId, created.id);
    await second.store.dispose();
    const backup = JSON.parse(await readFile(join(dir, 'state.v1.json'), 'utf8')) as { version: number };
    assert.equal(backup.version, 1);

    // A restart yields the same refusal.
    const third = await harness({ dir });
    await assert.rejects(() => third.engine.createTask(input), /operation-archived/);
    assert.equal(third.engine.tasks().length, 1);
    await third.store.dispose();
  });

  it('refuses to replay a migrated refresh id without running Git again', async () => {
    const dir = await tempDir();
    let calls = 0;
    const git = fakeGit({
      verifyResult: async input => {
        calls += 1;
        return { ok: true, files: [], patch: '', truncated: false, branchHead: input.headSha, verifiedAt: 1 };
      },
    });
    const first = await harness({ dir, git });
    await subscribeAndVerify(first.engine, first.clock);
    const task = await first.engine.createTask(taskInput());
    await first.engine.dispatchTick();
    const round = first.engine.task(task.id).rounds[0];
    await first.engine.claimTask({ connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId });
    await first.engine.processResult({ connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-r', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    const operationId = randomUUID();
    const revision = first.engine.task(task.id).revision;
    await first.engine.refreshResult({ operationId, id: task.id, revision });
    const callsAfter = calls;
    await first.store.dispose();
    await archiveOperation(dir, operationId);

    const second = await harness({ dir, git });
    await assert.rejects(() => second.engine.refreshResult({ operationId, id: task.id, revision }), /operation-archived/);
    assert.equal(calls, callsAfter);
    await second.store.dispose();
  });

  it('refuses to replay a migrated connection-test id', async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    await subscribe(first.engine, 'paseo.dot.connection_test');
    const operationId = randomUUID();
    await first.engine.startConnectionTest(operationId);
    await first.store.dispose();
    await archiveOperation(dir, operationId);

    const second = await harness({ dir });
    await assert.rejects(() => second.engine.startConnectionTest(operationId), /operation-archived/);
    await second.store.dispose();
  });
});

describe('engine result outcome idempotency', () => {
  it('replays a result with its original coverage after a new message lowers the live coverage', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const payload = { connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-cov', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 };
    const first = await engine.processResult(payload);
    assert.equal(first.coversLatest, true);
    assert.equal(first.duplicate, false);
    clock.value += 5;
    await engine.addMessage({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID(), body: 'more', kind: 'requirement' });
    // The live task now shows the result as not covering the newest message...
    assert.equal(engine.task(task.id).rounds[0].result?.coversLatest, false);
    // ...but the replay returns the updateId's own immutable outcome, not the recomputed one.
    const replay = await engine.processResult(payload);
    assert.equal(replay.coversLatest, true);
    assert.equal(replay.accepted, true);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.verification.status, 'verified');
    assert.equal(replay.verification.updateId, 'u-cov');
    assert.equal(replay.verification.headSha, HEAD);
  });

  it('returns the original outcome for a history replay after a later result replaced it', async () => {
    const { engine, clock } = await harness();
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const base = { connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, baseSha: BASE, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 };
    await engine.processResult({ ...base, updateId: 'u-1', headSha: HEAD });
    await engine.processResult({ ...base, updateId: 'u-2', headSha: '3'.repeat(40) });
    assert.equal(engine.task(task.id).rounds[0].resultHistory.length, 1);
    const replay = await engine.processResult({ ...base, updateId: 'u-1', headSha: HEAD });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.accepted, true);
    assert.equal(replay.verification.updateId, 'u-1');
    assert.equal(replay.verification.headSha, HEAD);
  });

  it('keeps a result outcome stable across a later re-verification', async () => {
    let patch = 'first';
    const git = fakeGit({
      verifyResult: async input => ({ ok: true, files: [], patch, truncated: false, branchHead: input.headSha, verifiedAt: 1 }),
    });
    const { engine, clock } = await harness({ git });
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const payload = { connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-rv', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 };
    const first = await engine.processResult(payload);
    assert.equal(first.verification.patch, 'first');
    patch = 'second';
    await engine.refreshResult({ operationId: randomUUID(), id: task.id, revision: engine.task(task.id).revision });
    assert.equal(engine.task(task.id).rounds[0].verification.patch, 'second');
    const replay = await engine.processResult(payload);
    // The replay returns the outcome computed for this updateId, not the refreshed verification.
    assert.equal(replay.verification.patch, 'first');
    assert.equal(replay.verification.updateId, 'u-rv');
  });

  it('shares one Git run between concurrent duplicate submissions', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const git = fakeGit({
      verifyResult: async input => {
        calls += 1;
        await gate;
        return { ok: true, files: [], patch: 'p', truncated: false, branchHead: input.headSha, verifiedAt: 1 };
      },
    });
    const { engine, clock } = await harness({ git });
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    const payload = { connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-conc', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 };
    const first = engine.processResult(payload);
    const second = engine.processResult(payload);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(a.verification.status, 'verified');
    assert.equal(b.verification.status, 'verified');
    assert.equal(a.coversLatest, b.coversLatest);
  });

  it('replays a result with its original outcome after a restart', async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    await subscribeAndVerify(first.engine, first.clock);
    const task = await first.engine.createTask(taskInput());
    await first.engine.dispatchTick();
    const round = first.engine.task(task.id).rounds[0];
    await first.engine.claimTask({ connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId });
    const payload = { connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-persist', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 };
    const outcome = await first.engine.processResult(payload);
    assert.equal(outcome.verification.status, 'verified');
    await first.store.dispose();

    const second = await harness({ dir });
    const replay = await second.engine.processResult(payload);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.verification.status, 'verified');
    assert.equal(replay.verification.updateId, 'u-persist');
    assert.equal(second.engine.tasks().length, 1);
    await second.store.dispose();
  });
});

describe('engine large results', () => {
  it('stores a large verified result and still allows appending, re-verifying, a new round and a reopen', async () => {
    const dir = await tempDir();
    const bigPatch = 'x'.repeat(199_000);
    const git = fakeGit({
      verifyResult: async input => ({ ok: true, files: ['big.txt'], patch: bigPatch, truncated: false, branchHead: input.headSha, verifiedAt: 1 }),
    });
    const first = await harness({ dir, git });
    await subscribeAndVerify(first.engine, first.clock);
    const task = await first.engine.createTask(taskInput({ requirement: 'r'.repeat(8_000) }));
    await first.engine.dispatchTick();
    const round = first.engine.task(task.id).rounds[0];
    await first.engine.claimTask({ connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId });
    const outcome = await first.engine.processResult({ connectionId: first.engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: 'u-big', baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'big', checks: [], prUrl: null, processedThroughSeq: 1 });
    assert.equal(outcome.verification.status, 'verified');
    assert.equal(outcome.verification.patch.length, 199_000);
    // The Task JSON is now larger than the old 200 000-character receipt cap.
    assert.ok(JSON.stringify(first.engine.task(task.id)).length > 200_000);

    // Appending a requirement must persist (previously threw a Zod `too_big` on the receipt).
    const operationId = randomUUID();
    const revision = first.engine.task(task.id).revision;
    const afterAdd = await first.engine.addMessage({ id: task.id, revision, operationId, body: 'one more', kind: 'requirement' });
    assert.equal(afterAdd.messages.filter(message => message.author === 'user').length, 2);
    // Replaying the add returns the original response and does not add a second message.
    const replayAdd = await first.engine.addMessage({ id: task.id, revision, operationId, body: 'one more', kind: 'requirement' });
    assert.equal(replayAdd.messages.filter(message => message.author === 'user').length, 2);

    // Re-verify and a new round both work after the large result.
    const refreshed = await first.engine.refreshResult({ operationId: randomUUID(), id: task.id, revision: first.engine.task(task.id).revision });
    assert.equal(refreshed.rounds[0].verification.status, 'verified');
    const next = await first.engine.createRound({ id: task.id, revision: first.engine.task(task.id).revision, operationId: randomUUID() });
    assert.equal(next.rounds.length, 2);
    await first.store.dispose();

    // Everything survives a reopen.
    const second = await harness({ dir, git });
    assert.equal(second.engine.tasks().length, 1);
    const restored = second.engine.task(task.id);
    assert.equal(restored.rounds.length, 2);
    assert.equal(restored.messages.filter(message => message.author === 'user').length, 2);
    assert.equal(restored.rounds[0].verification.patch.length, 199_000);
    await second.store.dispose();
  });

  it('keeps working after the accumulated result history exceeds 200k', async () => {
    let patch = 'y'.repeat(80_000);
    const git = fakeGit({
      verifyResult: async input => ({ ok: true, files: [], patch, truncated: false, branchHead: input.headSha, verifiedAt: 1 }),
    });
    const { engine, clock } = await harness({ git });
    await subscribeAndVerify(engine, clock);
    const task = await engine.createTask(taskInput());
    await engine.dispatchTick();
    const round = engine.task(task.id).rounds[0];
    await engine.claimTask({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId });
    for (let index = 0; index < 3; index += 1) {
      patch = `${'y'.repeat(80_000)}-${index}`;
      await engine.processResult({ connectionId: engine.connection().id, taskId: task.id, roundId: round.roundId, updateId: `u-h${index}`, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, processedThroughSeq: 1 });
    }
    assert.equal(engine.task(task.id).rounds[0].resultHistory.length, 2);
    assert.ok(JSON.stringify(engine.task(task.id)).length > 200_000);
    const afterAdd = await engine.addMessage({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID(), body: 'still editable', kind: 'requirement' });
    assert.equal(afterAdd.messages.filter(message => message.author === 'user').length, 2);
  });
});

describe('text tasks without Git', () => {
  function textInput() {
    return { ...taskInput(), mode: 'text' as const, repository: null, remoteName: null, baseSha: null, targetBranch: null };
  }
  function textResult(engine: BridgeEngine, task: ReturnType<BridgeEngine['task']>, text = 'A written analysis') {
    return {
      kind: 'text' as const, connectionId: engine.connection().id, taskId: task.id,
      roundId: task.currentRoundId, updateId: randomUUID(), summary: text,
      baseSha: null, headSha: null, branch: null, checks: [], prUrl: null,
      processedThroughSeq: task.userMessageSeq,
    };
  }

  it('dispatches, answers, continues and restores history without invoking Git', async () => {
    let gitCalls = 0;
    const unexpectedGit = async (): Promise<never> => { gitCalls++; throw new Error('Text task invoked Git'); };
    const { engine, store, clock } = await harness({ git: fakeGit({ baseReachable: unexpectedGit, verifyResult: unexpectedGit, prMatches: unexpectedGit }) });
    const input = textInput();
    const task = await engine.createTask(input);
    assert.equal(task.repository, null);
    assert.equal(task.branch, null);
    assert.deepEqual(await engine.createTask(input), task);
    assert.deepEqual(await engine.dispatchTick(), []); // Connection is still required.
    await subscribeAndVerify(engine, clock);
    assert.deepEqual(await engine.dispatchTick(), [task.id]);
    await engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
    const result = textResult(engine, task);
    const outcome = await engine.processResult(result);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.coversLatest, true);
    assert.equal(outcome.verification.status, 'none');
    assert.equal(engine.task(task.id).status, 'completed');
    assert.equal((await engine.processResult(result)).duplicate, true);
    let saved = engine.task(task.id);
    await assert.rejects(engine.refreshResult({ id: task.id, revision: saved.revision, operationId: randomUUID() }), /no Git result/);
    await assert.rejects(engine.retryRound({ id: task.id, revision: saved.revision, operationId: randomUUID() }), /retry-unavailable/);
    const continued = await engine.createRound({ id: task.id, revision: saved.revision, operationId: randomUUID() });
    const followup = await engine.addMessage({ id: task.id, revision: continued.revision, operationId: randomUUID(), body: 'Expand the plan', kind: 'requirement' });
    assert.deepEqual(await engine.dispatchTick(), [task.id]);
    await engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: continued.currentRoundId });
    const late = await engine.processResult({ ...result, updateId: randomUUID(), summary: 'Late first answer' });
    assert.equal(late.reason, 'stale-round');
    assert.equal(engine.task(task.id).status, 'claimed');
    await engine.processResult(textResult(engine, followup, 'Expanded plan'));
    saved = engine.task(task.id);
    const history = engine.historyForTask(task.id, null);
    assert.equal(history.records.length, 3);
    assert.ok(history.records.every(record => record.result.kind === 'text'));
    const replay = await engine.processResult(result);
    assert.equal(replay.coversLatest, true); // Replays its original outcome, not the latest round.
    assert.equal(gitCalls, 0);
    await store.dispose();
    const reopened = await harness({ dir: store.dir });
    assert.equal(reopened.store.loadError, null);
    assert.deepEqual(reopened.engine.task(task.id), saved);
    assert.equal((await reopened.engine.processResult(result)).duplicate, true);
    await reopened.store.dispose();
  });

  it('keeps coverage honest and rejects wrong-mode results and missing claims', async () => {
    const { engine, clock, store } = await harness();
    const task = await engine.createTask(textInput());
    await assert.rejects(engine.processResult(textResult(engine, task)), /claim-required/);
    await subscribeAndVerify(engine, clock);
    await engine.dispatchTick();
    await engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
    await assert.rejects(engine.processResult({ ...textResult(engine, task), summary: '   ' }));
    await assert.rejects(engine.processResult({ ...textResult(engine, task), kind: 'git', baseSha: BASE, headSha: HEAD, branch: 'dot/test' }));
    const result = textResult(engine, task);
    await engine.addMessage({ id: task.id, revision: engine.task(task.id).revision, operationId: randomUUID(), body: 'Also explain costs', kind: 'requirement' });
    assert.equal((await engine.processResult(result)).coversLatest, false);
    const latest = engine.task(task.id);
    assert.equal(latest.rounds[0].result?.coversLatest, false);
    await engine.processResult(textResult(engine, latest, 'Analysis including costs'));
    const answered = engine.task(task.id);
    assert.equal(answered.rounds[0].result?.coversLatest, true);
    assert.equal(answered.rounds[0].resultHistory.length, 1);
    const gitTask = await engine.createTask(taskInput());
    await engine.dispatchTick();
    await engine.claimTask({ connectionId: gitTask.connectionId, taskId: gitTask.id, roundId: gitTask.currentRoundId });
    await assert.rejects(engine.processResult({ ...textResult(engine, gitTask), baseSha: BASE }), /invalid|match/i);
    await store.dispose();
  });

  it('retries failed and locally canceled text rounds without inventing a Git base', async () => {
    const { engine, clock, store } = await harness();
    const task = await engine.createTask(textInput());
    const canceled = await engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
    const retry = await engine.retryRound({ id: task.id, revision: canceled.revision, operationId: randomUUID() });
    assert.equal(retry.cancelRequested, false);
    assert.equal(retry.rounds[1].baseSha, null);
    await subscribeAndVerify(engine, clock);
    await engine.dispatchTick();
    await engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: retry.currentRoundId });
    await engine.reportProgress({ connectionId: task.connectionId, taskId: task.id, roundId: retry.currentRoundId, updateId: randomUUID(), kind: 'failed', note: 'Try again', processedThroughSeq: 1 });
    const failed = engine.task(task.id);
    const again = await engine.retryRound({ id: task.id, revision: failed.revision, operationId: randomUUID() });
    assert.equal(again.rounds.length, 3);
    assert.equal(again.status, 'queued');
    assert.equal(again.repository, null);
    await store.dispose();
  });
});

it('migrates a v3 Git task and result to the current format without breaking operation replay', async () => {
  const { engine, store, clock } = await harness();
  const input = taskInput();
  const task = await engine.createTask(input);
  await subscribeAndVerify(engine, clock);
  await engine.dispatchTick();
  await engine.claimTask({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId });
  await engine.processResult({ connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId, updateId: randomUUID(), baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'Git delivery', checks: [], prUrl: null, processedThroughSeq: 1 });
  await store.dispose();
  const statePath = join(store.dir, 'state.json');
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  legacy.version = 3;
  delete legacy.tasks[0].mode;
  delete legacy.tasks[0].attachments;
  delete legacy.tasks[0].rounds[0].result.kind;
  const bytes = JSON.stringify(legacy);
  await writeFile(statePath, bytes);
  const reopened = await harness({ dir: store.dir });
  try {
    assert.equal(reopened.store.loadError, null);
    assert.equal(reopened.store.read().version, 9);
    const restored = reopened.engine.task(task.id);
    assert.equal(restored.mode, 'git');
    assert.deepEqual(restored.attachments, []);
    assert.equal(restored.rounds[0].result?.kind, 'git');
    assert.equal(restored.rounds[0].verification.status, 'verified');
    assert.equal((await reopened.engine.createTask(input)).id, task.id);
    assert.equal(reopened.engine.tasks().length, 1);
    assert.equal(await readFile(join(store.dir, 'state.v3.json'), 'utf8'), bytes);
  } finally {
    await reopened.store.dispose();
  }
});

describe('task attachments', () => {
  function newTextTask(engine: BridgeEngine) {
    return engine.createTask({ ...taskInput(), mode: 'text', repository: null, remoteName: null, baseSha: null, targetBranch: null });
  }
  function uploadInput(task: ReturnType<BridgeEngine['task']>, content = '\ufeff中文附件\nline 2') {
    return { operationId: randomUUID(), id: task.id, roundId: task.currentRoundId, revision: task.revision, actor: 'user' as const, name: 'note.txt', mediaType: 'text/plain', encoding: 'utf8' as const, content };
  }
  it('publishes user attachments as new messages, supports exact replay and survives restart', async () => {
    const { engine, store } = await harness();
    const task = await newTextTask(engine);
    const input = uploadInput(task);
    const saved = await engine.uploadAttachment(input);
    assert.equal(saved.attachment.author, 'user');
    const updated = engine.task(task.id);
    assert.equal(updated.userMessageSeq, 2);
    assert.equal(updated.attachments.length, 1);
    assert.ok(updated.messages[1].body.includes(saved.attachment.id));
    assert.deepEqual(await engine.uploadAttachment(input), saved);
    await assert.rejects(engine.uploadAttachment({ ...input, content: 'changed' }), /duplicate-mismatch/);
    const content = await engine.readAttachment(task.id, saved.attachment.id, task.connectionId);
    assert.equal(content.encoding, 'utf8');
    assert.equal(content.content, input.content); // UTF-8 BOM is retained, not silently removed.
    const other = await newTextTask(engine);
    await assert.rejects(engine.readAttachment(other.id, saved.attachment.id), /attachment-missing/);
    await assert.rejects(engine.readAttachment(task.id, saved.attachment.id, 'wrong'), /connection-invalid/);
    await store.dispose();
    const reopened = await harness({ dir: store.dir });
    assert.equal(reopened.store.loadError, null);
    assert.deepEqual(await reopened.engine.readAttachment(task.id, saved.attachment.id), content);
    assert.deepEqual(await reopened.engine.uploadAttachment(input), saved);
    await reopened.store.dispose();
  });

  it('requires a current claimed round for dot files, fences late uploads, and invalidates result coverage for user files', async () => {
    const { engine, store, clock } = await harness();
    const task = await newTextTask(engine);
    const { revision: _, ...base } = uploadInput(task);
    const input = { ...base, actor: 'dot' as const, connectionId: task.connectionId };
    await assert.rejects(engine.uploadAttachment(input), /claim-required/);
    await subscribeAndVerify(engine, clock);
    await engine.dispatchTick();
    await engine.claimTask({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId });
    const file = await engine.uploadAttachment(input);
    assert.equal(file.attachment.author, 'dot');
    assert.equal(engine.task(task.id).userMessageSeq, 1);
    await engine.processResult({ kind: 'text', connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId, updateId: randomUUID(), baseSha: null, headSha: null, branch: null, summary: 'See the attached file', checks: [], prUrl: null, processedThroughSeq: 1 });
    const completed = engine.task(task.id);
    await engine.uploadAttachment(uploadInput(completed, 'New requirement'));
    assert.equal(engine.task(task.id).rounds[0].result?.coversLatest, false);
    const current = engine.task(task.id);
    await engine.createRound({ operationId: randomUUID(), id: task.id, revision: current.revision });
    assert.deepEqual(await engine.uploadAttachment(input), file); // Already accepted upload can replay.
    await assert.rejects(engine.uploadAttachment({ ...input, operationId: randomUUID() }), /round-stale/);
    await store.dispose();
  });

  it('enforces task quotas and revision checks across concurrent uploads', async () => {
    const { engine, store } = await harness();
    const task = await newTextTask(engine);
    const inputs = [uploadInput(task, 'A'), uploadInput(task, 'B')];
    const outcomes = await Promise.allSettled(inputs.map(input => engine.uploadAttachment(input)));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(engine.task(task.id).attachments.length, 1);
    for (let i = 1; i < 16; i++) await engine.uploadAttachment(uploadInput(engine.task(task.id), `file ${i}`));
    const full = engine.task(task.id);
    await assert.rejects(engine.uploadAttachment(uploadInput(full, 'overflow')), /attachment-limit/);
    assert.equal(engine.task(task.id).attachments.length, 16);
    await store.dispose();
  });
});
