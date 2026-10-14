import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BridgeEngine } from '../server/engine';
import type { FetchLike } from '../server/http';
import { generateSecret } from '../server/signing';
import { BridgeStore } from '../server/store';

const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));

/** Answers protocol verification with a 2xx echo, and app events with the configured status. */
function deliveryFetch(responder: (call: number) => Response): FetchLike {
  let calls = 0;
  return async (_url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    try {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === 'verification' && typeof parsed.challenge === 'string') {
        return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    } catch {
      /* not a verification body */
    }
    calls += 1;
    return responder(calls);
  };
}

async function engineWith(fetchImpl: FetchLike, clock: { value: number }): Promise<BridgeEngine> {
  const dir = await mkdtemp(join(tmpdir(), 'dot-bridge-events-'));
  scratch.push(dir);
  const store = await BridgeStore.open(dir);
  const engine = new BridgeEngine({
    store,
    git: {
      inspectRepository: async () => ({ directory: null, remotes: [], branch: null, head: null, dirty: false, unpushed: false }),
      resolveRepository: async d => d,
      verifyResult: async () => ({ ok: false, code: 'git-failed', detail: 'x' }),
      baseReachable: async () => true,
      prMatches: async () => true,
    },
    now: () => clock.value,
    fetchImpl,
    getMaxInFlight: () => 2,
    allowPrivateCallback: true,
    randomId: () => randomUUID(),
  });
  await engine.init();
  engine.setBridgeListening(true);
  for (const name of ['paseo.dot.task_changed', 'paseo.dot.connection_test'] as const) {
    await engine.setSubscription({
      name,
      arguments: { connectionId: engine.connection().id },
      delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
      cursor: null,
    });
  }
  return engine;
}

function eventStatus(engine: BridgeEngine): Array<{ name: string; status: string; attempts: number }> {
  const store = (engine as unknown as { deps: { store: BridgeStore } }).deps.store;
  return store.read().events.map(event => ({ name: event.name, status: event.status, attempts: event.attempts }));
}

describe('event delivery', () => {
  it('retries a transient failure with backoff and keeps the eventId', async () => {
    const clock = { value: 1_000_000 };
    const engine = await engineWith(deliveryFetch(call => new Response('', { status: call === 1 ? 500 : 200 })), clock);
    const challenge = await engine.startConnectionTest(randomUUID());
    assert.ok(challenge.challenge);
    await engine.deliverTick();
    let events = eventStatus(engine);
    assert.equal(events[0].status, 'pending');
    assert.equal(events[0].attempts, 1);
    clock.value += 3000;
    await engine.deliverTick();
    events = eventStatus(engine);
    assert.equal(events[0].status, 'delivered');
  });

  it('does not retry a 410', async () => {
    const clock = { value: 1_000_000 };
    let deliveries = 0;
    const engine = await engineWith(deliveryFetch(() => { deliveries++; return new Response('', { status: 410 }); }), clock);
    await engine.startConnectionTest(randomUUID());
    await engine.deliverTick();
    const events = eventStatus(engine);
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].attempts, 0);
    clock.value += 3000;
    await engine.deliverTick();
    assert.equal(deliveries, 1);
    assert.deepEqual(eventStatus(engine), events);
  });

  it('honours Retry-After on a 429', async () => {
    const clock = { value: 1_000_000 };
    const engine = await engineWith(deliveryFetch(call => (call === 1 ? new Response('', { status: 429, headers: { 'retry-after': '5' } }) : new Response('', { status: 200 }))), clock);
    await engine.startConnectionTest(randomUUID());
    await engine.deliverTick();
    assert.equal(eventStatus(engine)[0].attempts, 1);
    // Still inside the Retry-After window.
    clock.value += 4000;
    await engine.deliverTick();
    assert.equal(eventStatus(engine)[0].status, 'pending');
    clock.value += 2000;
    await engine.deliverTick();
    assert.equal(eventStatus(engine)[0].status, 'delivered');
  });

  it('does not deliver an event with no matching subscription', async () => {
    const clock = { value: 1_000_000 };
    const dir = await mkdtemp(join(tmpdir(), 'dot-bridge-events-'));
    scratch.push(dir);
    const store = await BridgeStore.open(dir);
    const engine = new BridgeEngine({
      store,
      git: {
        inspectRepository: async () => ({ directory: null, remotes: [], branch: null, head: null, dirty: false, unpushed: false }),
        resolveRepository: async d => d,
        verifyResult: async () => ({ ok: false, code: 'git-failed', detail: 'x' }),
        baseReachable: async () => true,
        prMatches: async () => true,
      },
      now: () => clock.value,
      fetchImpl: deliveryFetch(() => new Response('', { status: 200 })),
      getMaxInFlight: () => 2,
      allowPrivateCallback: true,
      randomId: () => randomUUID(),
    });
    await engine.init();
    // Only the connection_test event is subscribed; task_changed stays pending.
    await engine.setSubscription({
      name: 'paseo.dot.connection_test',
      arguments: { connectionId: engine.connection().id },
      delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
      cursor: null,
    });
    await engine.createTask({
      operationId: randomUUID(),
      workspaceId: 'ws-1',
      title: 'T',
      requirement: 'R',
      acceptance: '',
      repository: 'https://github.com/acme/repo.git',
      remoteName: 'origin',
      baseSha: '1'.repeat(40),
      targetBranch: 'main',
      environmentHint: '',
    });
    await engine.deliverTick();
    const taskChanged = eventStatus(engine).find(event => event.name === 'paseo.dot.task_changed');
    assert.equal(taskChanged, undefined); // Queued work is only notified after dispatch.
  });
});
