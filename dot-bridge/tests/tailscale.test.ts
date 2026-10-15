import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTailscaleIp, isTailscaleOrigin, tailscalePeer } from '../shared/tailscale';
import { remoteConfigSchema } from '../shared/remote';
import { authenticateTailscale } from '../server/tailscale';
import { RemoteStateStore } from '../server/remote-state';
import { BridgeStore } from '../server/store';
import { BridgeEngine } from '../server/engine';
import { RemoteCenter } from '../server/remote-center';
import { RemoteRuntime } from '../server/remote-runtime';

const centerIp = '100.96.195.115', peerIp = '100.90.20.30';

test('Tailscale direct accepts only numeric tailnet origins and actual tailnet socket peers', () => {
  for (const value of ['100.64.0.0', '100.127.255.255', centerIp, '::ffff:' + peerIp]) assert.equal(isTailscaleIp(value), true);
  for (const value of ['100.63.255.255', '100.128.0.0', '100.96.195.256', '100.096.195.115', '127.0.0.1', '192.168.1.1', 'host.ts.net', '100.96.195.115.evil']) assert.equal(isTailscaleIp(value), false);
  assert.equal(isTailscaleOrigin('http://' + centerIp + ':47823'), true);
  for (const value of ['https://' + centerIp, 'http://host.ts.net', 'http://user:pass@' + centerIp, 'http://' + centerIp + '/path', 'http://' + centerIp + '?x=1']) assert.equal(isTailscaleOrigin(value), false);
  assert.equal(tailscalePeer(centerIp, '::ffff:' + peerIp), peerIp);
  assert.equal(tailscalePeer('127.0.0.1', peerIp), null);
  assert.equal(tailscalePeer(centerIp, '192.168.1.2'), null);
});

test('Tailscale enrollment is automatic, isolated by peer, durable and concurrent-safe', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-tailnet-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new RemoteStateStore(dir); await state.load();
  await state.mutate(draft => { draft.config = remoteConfigSchema.parse({ mode: 'center', transport: 'tailscale', host: centerIp }); });
  const devices = await Promise.all(Array.from({ length: 5 }, () => authenticateTailscale(state, centerIp, peerIp)));
  assert.ok(devices[0]); assert.equal(new Set(devices.map(device => device?.id)).size, 1);
  assert.equal(state.read().devices.length, 1);
  assert.deepEqual(devices[0].capabilities, { chat: true, attachments: true, readFiles: true, writeFiles: true });
  assert.deepEqual(devices[0].workspaceIds, []); assert.equal(devices[0].tokenHash, '');
  const other = await authenticateTailscale(state, centerIp, '100.90.20.31'); assert.notEqual(other?.id, devices[0].id);
  const reloaded = new RemoteStateStore(dir); await reloaded.load();
  assert.equal((await authenticateTailscale(reloaded, centerIp, peerIp))?.id, devices[0].id);
  await reloaded.mutate(draft => { draft.devices[0].revoked = true; });
  assert.equal(await authenticateTailscale(reloaded, centerIp, peerIp), undefined);
  assert.equal(reloaded.read().devices.length, 2);
});

test('Tailscale enrollment refuses other transports, modes, interfaces and private peers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-tailnet-reject-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new RemoteStateStore(dir); await state.load();
  assert.equal(await authenticateTailscale(state, centerIp, peerIp), undefined);
  await state.mutate(draft => { draft.config = remoteConfigSchema.parse({ mode: 'center', host: centerIp }); });
  assert.equal(await authenticateTailscale(state, centerIp, peerIp), undefined);
  await state.mutate(draft => { draft.config.transport = 'tailscale'; });
  for (const [local, remote] of [['127.0.0.1', peerIp], ['100.90.20.10', peerIp], [centerIp, '127.0.0.1'], [centerIp, '192.168.1.2'], [centerIp, undefined]]) assert.equal(await authenticateTailscale(state, local, remote), undefined);
  assert.equal(state.read().devices.length, 0);
});

test('forwarded Tailscale addresses do not authenticate a loopback HTTP request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-tailnet-http-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await BridgeStore.open(join(dir, 'bridge')); const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const state = new RemoteStateStore(join(dir, 'center')); await state.load();
  await state.mutate(draft => { draft.config.mode = 'center'; draft.config.port = 0; });
  const center = new RemoteCenter(state, engine, async () => {}); await center.start();
  t.after(async () => { await center.stop(); engine.dispose(); await store.dispose(); });
  const response = await fetch(center.endpoint + '/dot/remote/v1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': peerIp, 'tailscale-user-login': 'fake@example.com' }, body: JSON.stringify({ action: 'hello', input: {} }) });
  assert.equal(response.status, 401); assert.equal(state.read().devices.length, 0);
  await center.stop(); await state.mutate(draft => { draft.config.transport = 'tailscale'; });
  await assert.rejects(center.start(), /Tailscale bind address/);
});

test('Tailscale remote saves without credentials, workspace IDs, HTTP or capability switches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-tailnet-client-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await BridgeStore.open(join(dir, 'bridge')); const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const runtime = new RemoteRuntime(engine, join(dir, 'runtime'), async () => {}); await runtime.start();
  t.after(async () => { await runtime.close(); engine.dispose(); await store.dispose(); });
  const requests: Array<{ action: string; headers: Record<string, string> }> = [];
  const device = { id: randomUUID(), name: 'tailnet', tailscaleIp: peerIp, workspaceIds: [], revoked: false, createdAt: Date.now(), capabilities: { chat: true, attachments: true, readFiles: true, writeFiles: true } };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push({ action: body.action, headers: init.headers as Record<string, string> });
    const value = body.action === 'prompt' ? await engine.providerPrompt({ ...body.input, remoteOrigin: { deviceId: device.id, workspaceId: body.input.workspaceId } })
      : body.action === 'hello' ? { device, ready: true } : body.action === 'catalog' ? { entries: [], cursor: null } : { jobs: [], cursor: null };
    return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
  });
  const config = remoteConfigSchema.parse({ mode: 'remote', transport: 'tailscale', url: 'http://' + centerIp + ':47823' });
  const status = await runtime.configure(config);
  assert.equal(status.connected, true); assert.equal(status.tokenConfigured, false); assert.deepEqual(status.config.workspaceIds, []);
  assert.equal(status.config.privateHttp, false); assert.equal(status.config.writeFiles, false);
  assert.ok(requests.some(request => request.action === 'hello'));
  assert.ok(requests.every(request => !('authorization' in request.headers)));
  // A new conversation reaches the center with an automatically saved local workspace binding.
  const client = runtime.client!;
  const reply = await client.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: 'auto', workspaceId: 'auto-workspace', cwd: dir, body: 'hello', systemPrompt: '', attachments: [] });
  assert.equal(reply.task.workspaceId, 'auto-workspace'); assert.equal(reply.task.remoteOrigin?.deviceId, device.id);
  assert.equal(reply.task.workspaceRoot, null);
  assert.ok(requests.some(request => request.action === 'prompt'));
  assert.equal(runtime.state.read().bindings.at(-1)?.workspaceId, 'auto-workspace');
});

const liveAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && isTailscaleIp(address.address))?.address;
test('live Tailscale interface: two runtimes connect and edit an automatically bound remote workspace', { skip: !liveAddress, timeout: 15000 }, async t => {
  const { withDispatch } = await import('../shared/machine');
  const { sourceHash } = await import('../server/local-files');
  const dir = await mkdtemp(join(tmpdir(), 'dot-tailnet-live-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'remote-workspace'); await mkdir(root); await writeFile(join(root, 'note.txt'), 'before\n');
  const store = await BridgeStore.open(join(dir, 'center-bridge')); const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const center = new RemoteRuntime(engine, join(dir, 'center'), async () => {}); await center.start();
  const localStore = await BridgeStore.open(join(dir, 'remote-bridge')); const localEngine = new BridgeEngine({ store: localStore, getMaxInFlight: () => 2 }); await localEngine.init();
  const remote = new RemoteRuntime(localEngine, join(dir, 'remote'), async () => {}); await remote.start();
  t.after(async () => { await remote.close(); await center.close(); engine.dispose(); localEngine.dispose(); await store.dispose(); await localStore.dispose(); });
  const centerStatus = await center.configure(remoteConfigSchema.parse({ mode: 'center', transport: 'tailscale', host: liveAddress, port: 0 }));
  assert.equal(centerStatus.connected, true);
  const remoteStatus = await remote.configure(remoteConfigSchema.parse({ mode: 'remote', transport: 'tailscale', url: centerStatus.endpoint }));
  assert.equal(remoteStatus.connected, true); assert.equal(remoteStatus.tokenConfigured, false);
  const client = remote.client!;
  const reply = await client.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: 'live', workspaceId: 'automatically-bound', cwd: root, body: 'Update note.txt', systemPrompt: '', attachments: [] });
  assert.deepEqual(center.state.read().devices[0].workspaceIds, ['automatically-bound']);
  assert.equal(engine.task(reply.task.id).workspaceRoot, null);
  await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0], Date.now()); });
  const identity = { connectionId: reply.task.connectionId, taskId: reply.task.id, roundId: reply.task.currentRoundId };
  await engine.claimTask(identity);
  const operationId = randomUUID();
  const pending = center.center.requestFile('apply', { ...identity, operationId, userMessageSeq: engine.task(reply.task.id).userMessageSeq, changes: [{ path: 'note.txt', content: 'after\n', expectedSha256: sourceHash('before\n') }] });
  const deadline = Date.now() + 3000;
  while (!center.state.read().jobs.some(job => job.input.operationId === operationId)) {
    if (Date.now() > deadline) throw new Error('File request was not queued');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await client.pump(); await pending;
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'after\n');
  assert.equal(remote.state.read().config.readFiles, false); assert.equal(remote.state.read().config.writeFiles, false);
  assert.deepEqual(remote.state.read().config.workspaceIds, []);
  assert.ok(engine.task(reply.task.id).localChanges.some(change => change.operationId === operationId));
});
