import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { remoteConfigSchema } from '../shared/remote';
import { deviceCanUse, remoteTaskView, RemoteCenter } from '../server/remote-center';
import { RemoteStateStore } from '../server/remote-state';
import { remoteUrl, remoteCall } from '../server/remote-http';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { applyLocalChanges, readChangeReceipt, readSource, canonicalWorkspace, sourceHash } from '../server/local-files';
import { withDispatch, createTask } from '../shared/machine';
import { canonicalJson } from '../shared/mcp';
import { assertRemoteJobIdentity, assertRemoteWritePermission, RemoteClient } from '../server/remote-client';
import { createMcpServer } from '../server/mcp-server';
import { taskSchema } from '../shared/schema';
import { fileJobSchema } from '../server/remote-state';

test('remote mode defaults closed and HTTP requires a trusted private destination', () => {
  assert.equal(remoteConfigSchema.parse({}).mode, 'local');
  assert.equal(remoteConfigSchema.parse({}).writeFiles, false);
  assert.equal(remoteUrl('https://center.example', false), 'https://center.example');
  assert.equal(remoteUrl('http://127.0.0.1:47823', true), 'http://127.0.0.1:47823');
  for (const [url, allowed] of [['http://127.0.0.1', false], ['http://example.com', true], ['https://user:pass@example.com', false], ['https://example.com/path', false], ['https://example.com?token=x', false]] as const) assert.throws(() => remoteUrl(url, allowed));
});

test('device access requires both exact workspace and non-revoked capability', () => {
  const device = { id: randomUUID(), name: 'Laptop', workspaceIds: ['one'], createdAt: 0, revoked: false, capabilities: { chat: true, attachments: true, readFiles: true, writeFiles: false } };
  assert.equal(deviceCanUse(device, 'one', 'chat'), true);
  assert.equal(deviceCanUse(device, 'two', 'chat'), false);
  assert.equal(deviceCanUse(device, 'one', 'writeFiles'), false);
  assert.equal(deviceCanUse({ ...device, revoked: true }, 'one', 'readFiles'), false);
});

test('MCP Git review routes through the center to the originating workspace and requires device read scope', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-remote-review-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'workspace'); await mkdir(root); execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'remote.ts'), 'remote source edit\n');
  const store = await BridgeStore.open(join(dir, 'bridge')), state = new RemoteStateStore(join(dir, 'center'));
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init(); await state.load();
  await state.mutate(draft => { draft.config.mode = 'center'; draft.config.port = 0; });
  const center = new RemoteCenter(state, engine, async () => {}); await center.start();
  t.after(async () => { await center.stop(); engine.dispose(); await store.dispose(); });
  const device = await center.createDevice({ name: 'review', workspaceIds: ['ws'], capabilities: { chat: true, attachments: false, readFiles: true, writeFiles: false } });
  const localState = new RemoteStateStore(join(dir, 'remote')); await localState.load();
  await localState.mutate(draft => { draft.config = remoteConfigSchema.parse({ mode: 'remote', url: center.endpoint, privateHttp: true, readFiles: true, workspaceIds: ['ws'] }); draft.token = device.token; });
  const client = new RemoteClient(localState, localState.dir); t.after(() => client.close());
  const reply = await client.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: 'review', workspaceId: 'ws', cwd: root, body: 'Review changes', systemPrompt: '', attachments: [] });
  await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
  const identity = { connectionId: reply.task.connectionId, taskId: reply.task.id, roundId: reply.task.currentRoundId }; await engine.claimTask(identity);
  const server = createMcpServer({ engine, host: '127.0.0.1', port: 0, getToken: () => engine.mcpToken(), remoteFiles: (kind, input) => center.requestFile(kind, input) });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const call = async (options: Record<string, unknown> = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engine.mcpToken()}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_dot_workspace_changes', arguments: { ...identity, ...options } } }) });
    return await response.json() as { error?: unknown; result?: { content: Array<{ text: string }> } };
  };
  let notify!: () => void; let queued = new Promise<void>(resolve => { notify = resolve; });
  const mutate = state.mutate.bind(state);
  state.mutate = async fn => { const result = await mutate(fn); if (state.read().jobs.some(job => job.kind === 'changes' && job.status === 'queued')) notify(); return result; };
  const pending = call();
  await Promise.race([queued, pending.then(() => { throw new Error('MCP call ended before remote routing'); })]);
  await client.pump();
  const result = await pending; assert.equal(result.error, undefined);
  const data = JSON.parse(result.result!.content[0]!.text);
  assert.equal(data.isGitRepository, true); assert.match(data.files[0].untrackedDiff, /remote source edit/);
  queued = new Promise<void>(resolve => { notify = resolve; });
  const continued = call({ snapshotId: data.snapshotId, path: 'remote.ts', diffKind: 'untracked', diffOffset: 0 });
  await Promise.race([queued, continued.then(() => { throw new Error('Continuation ended before remote routing'); })]);
  await client.pump();
  const part = await continued; assert.equal(part.error, undefined);
  assert.equal(JSON.parse(part.result!.content[0]!.text).files[0].untrackedDiff, data.files[0].untrackedDiff);
  await writeFile(join(root, 'remote.ts'), 'changed after first snapshot\n');
  queued = new Promise<void>(resolve => { notify = resolve; });
  const stale = call({ snapshotId: data.snapshotId, path: 'remote.ts', diffKind: 'untracked', diffOffset: 0 });
  await Promise.race([queued, stale.then(() => { throw new Error('Stale snapshot ended before remote routing'); })]);
  await client.pump(); assert.match(JSON.stringify((await stale).error), /snapshot changed/i);
  assert.equal(engine.task(reply.task.id).workspaceRoot, null); assert.deepEqual(engine.task(reply.task.id).localChanges, []);
  await state.mutate(draft => { draft.devices[0]!.capabilities.readFiles = false; });
  assert.ok((await call()).error);
});

test('center isolates tasks by authenticated device, rejects local filesystem fallback and revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-remote-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await BridgeStore.open(join(dir, 'bridge')), state = new RemoteStateStore(join(dir, 'remote'));
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  await state.load(); await state.mutate(draft => { draft.config.mode = 'center'; draft.config.port = 0; });
  const center = new RemoteCenter(state, engine, async () => {});
  await center.start(); t.after(async () => { await center.stop(); engine.dispose(); await store.dispose(); });
  const capabilities = { chat: true, attachments: true, readFiles: true, writeFiles: false };
  const first = await center.createDevice({ name: 'one', workspaceIds: ['ws'], capabilities });
  const second = await center.createDevice({ name: 'two', workspaceIds: ['ws'], capabilities });
  const input = { id: randomUUID(), operationId: randomUUID(), clientMessageId: 'message', workspaceId: 'ws', cwd: '/remote/workspace', body: 'hello', systemPrompt: '', attachments: [] };
  const reply = await remoteCall(center.endpoint, first.token, 'prompt', input) as { task: ReturnType<BridgeEngine['task']>; duplicate: boolean };
  assert.equal(reply.task.workspaceRoot, null); assert.equal(reply.task.remoteOrigin?.deviceId, first.device.id);
  assert.equal((await remoteCall(center.endpoint, first.token, 'prompt', input) as typeof reply).duplicate, true);
  await assert.rejects(remoteCall(center.endpoint, second.token, 'task', { id: input.id }));
  await assert.rejects(remoteCall(center.endpoint, second.token, 'prompt', input));
  await store.mutate(draft => { const index = draft.tasks.findIndex(task => task.id === input.id); draft.tasks[index] = withDispatch(draft.tasks[index]!, Date.now()); });
  const identity = { connectionId: reply.task.connectionId, taskId: input.id, roundId: reply.task.currentRoundId };
  await engine.claimTask(identity);
  assert.throws(() => engine.readLocalFile({ ...identity, path: 'main.ts' }), /bound/i);
  await assert.rejects(center.requestFile('apply', { ...identity, operationId: randomUUID(), userMessageSeq: reply.task.userMessageSeq, changes: [{ path: 'main.ts', expectedSha256: null, content: 'x' }] }));
  // Delay the completed lease save so a center-side stop can arrive before the reply.
  const readInput = { ...identity, path: 'main.ts' };
  const job = fileJobSchema.parse({ id: randomUUID(), taskId: input.id, roundId: identity.roundId, deviceId: first.device.id, userMessageSeq: engine.task(input.id).userMessageSeq, kind: 'read', input: readInput, hash: createHash('sha256').update(canonicalJson({ kind: 'read', input: readInput })).digest('hex'), expiresAt: Date.now() + 60000, status: 'queued', error: null });
  await state.mutate(draft => { draft.jobs.push(job); });
  let release!: () => void, notify!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const leased = new Promise<void>(resolve => { notify = resolve; });
  const originalMutate = state.mutate.bind(state);
  state.mutate = async change => { const result = await originalMutate(change); notify(); await gate; return result; };
  const confirmation = remoteCall(center.endpoint, first.token, 'file-confirm', { id: job.id }).then(() => 'accepted', () => 'rejected');
  try {
    await Promise.race([leased, confirmation.then(() => { throw new Error('Confirmation ended before the lease was saved'); })]);
    const active = engine.task(input.id);
    await engine.cancelRequest({ id: input.id, revision: active.revision, operationId: randomUUID() });
  } finally { release(); state.mutate = originalMutate; }
  assert.equal(await confirmation, 'rejected');
  await center.revokeDevice(first.device.id);
  await assert.rejects(remoteCall(center.endpoint, first.token, 'task', { id: input.id }));
  assert.equal(state.read().devices.some(device => JSON.stringify(device).includes(first.token)), false);
  const attachment = { id: randomUUID(), roundId: reply.task.currentRoundId, name: 'a.txt', mediaType: 'text/plain', size: 1, sha256: 'a'.repeat(64), author: 'dot' as const, createdAt: 0, localPath: '/center/private/a.txt' };
  const task = { ...reply.task, attachments: [attachment] };
  assert.equal(remoteTaskView(task).attachments[0]?.localPath, undefined);
  assert.equal(task.attachments[0]?.localPath, '/center/private/a.txt');
});

test('remote result outbox survives restart and receipt recovery never resumes writes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-outbox-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace'); await mkdir(workspace);
  const state = new RemoteStateStore(join(dir, 'state')); await state.load();
  const operationId = randomUUID(), taskId = randomUUID(), roundId = randomUUID();
  const changes = [{ path: 'main.ts', expectedSha256: null, content: 'initial' }];
  const receipt = applyLocalChanges({ dataDir: dir, root: canonicalWorkspace(workspace), operationId, taskId, roundId, userMessageSeq: 1, changes, at: Date.now() });
  const job = { id: randomUUID(), taskId, roundId, deviceId: randomUUID(), userMessageSeq: 1, kind: 'apply' as const, input: { operationId, changes }, hash: 'hash', expiresAt: Date.now() + 60000, status: 'leased' as const, error: null };
  await state.mutate(draft => { draft.results.push({ job, phase: 'ready', result: receipt, error: null }); });
  const reopened = new RemoteStateStore(join(dir, 'state')); await reopened.load();
  assert.deepEqual(reopened.read().results[0]?.result, receipt);
  await writeFile(join(workspace, 'main.ts'), 'user edit');
  assert.deepEqual(readChangeReceipt(dir, operationId), receipt);
  const file = join(dir, 'local-changes', operationId + '.json'), journal = JSON.parse(await readFile(file, 'utf8'));
  journal.finished = false; await writeFile(file, JSON.stringify(journal));
  assert.equal(readChangeReceipt(dir, operationId)?.status, 'partial');
  assert.equal(readSource(canonicalWorkspace(workspace), 'main.ts').content, 'user edit');
});

test('remote file execution rejects mismatched task, device, version and request contents', () => {
  const taskId = randomUUID(), roundId = randomUUID(), deviceId = randomUUID(), connectionId = 'a'.repeat(32);
  const task = taskSchema.parse(createTask({ id: taskId, roundId, connectionId, workspaceId: 'ws', mode: 'text', title: 'Remote', requirement: 'Edit', acceptance: '', repository: null, remoteName: null, branch: null, baseSha: null, targetBranch: null, environmentHint: '', at: 1 }));
  task.remoteOrigin = { deviceId, workspaceId: 'ws' }; task.workspaceRoot = null;
  const input = { taskId, roundId, connectionId, operationId: randomUUID(), userMessageSeq: 1, changes: [{ path: 'a.ts', expectedSha256: null, content: 'x' }] };
  const job = fileJobSchema.parse({ id: randomUUID(), deviceId, taskId, roundId, userMessageSeq: 1, kind: 'apply', input, hash: createHash('sha256').update(canonicalJson({ kind: 'apply', input })).digest('hex'), expiresAt: 1000, status: 'leased', error: null });
  assert.doesNotThrow(() => assertRemoteJobIdentity(job, task));
  assert.throws(() => assertRemoteJobIdentity(job, { ...task, id: randomUUID() }), /identity/);
  assert.throws(() => assertRemoteJobIdentity(job, { ...task, remoteOrigin: { deviceId: randomUUID(), workspaceId: 'ws' } }), /identity/);
  assert.throws(() => assertRemoteJobIdentity({ ...job, input: { ...input, userMessageSeq: 2 } }, task), /version/);
  assert.throws(() => assertRemoteJobIdentity({ ...job, input: { ...input, changes: [{ ...input.changes[0], content: 'changed' }] } }, task), /content/);
});

test('remote write approval binds the exact operation and rejects changed payloads, consumption and blocks', () => {
  const task = taskSchema.parse(createTask({ id: randomUUID(), roundId: randomUUID(), connectionId: 'b'.repeat(32), workspaceId: 'ws', mode: 'text', title: 'Remote', requirement: 'Edit', acceptance: '', repository: null, remoteName: null, branch: null, baseSha: null, targetBranch: null, environmentHint: '', at: 1 }));
  task.status = 'running'; task.rounds[0]!.remoteStatus = 'running'; task.rounds[0]!.claim = { taskId: task.id, claimedAt: 2 };
  const operation = { kind: 'files' as const, operationId: randomUUID(), changes: ['a.ts', 'b.ts'].map(path => ({ path, expectedSha256: null, contentSha256: sourceHash('content') })) };
  task.permissions = [{ requestId: randomUUID(), userMessageSeq: task.userMessageSeq, roundId: task.currentRoundId,
    title: 'Edit', description: 'Exact changes', scope: { toolName: 'apply_dot_changes', action: 'Edit files', targets: ['a.ts', 'b.ts'], operation },
    status: 'approved', requestedAt: 1, resolvedAt: 2, decisionMessageSeq: task.userMessageSeq, platformBlock: null, consumedAt: null }];
  assert.doesNotThrow(() => assertRemoteWritePermission(task, ['a.ts', 'b.ts'], operation));
  assert.throws(() => assertRemoteWritePermission(task, ['c.ts'], operation), /permission-required/);
  assert.throws(() => assertRemoteWritePermission(task, ['a.ts', 'b.ts'], { ...operation, operationId: randomUUID() }), /permission-required/);
  assert.throws(() => assertRemoteWritePermission(task, ['a.ts', 'b.ts'], { ...operation, changes: operation.changes.map(change => ({ ...change, contentSha256: sourceHash('other') })) }), /permission-required/);
  task.permissions[0]!.consumedAt = 3;
  assert.throws(() => assertRemoteWritePermission(task, ['a.ts', 'b.ts'], operation), /permission-required/);
  task.permissions[0]!.consumedAt = null; task.permissions[0]!.platformBlock = { reason: 'Platform confirmation required', at: 3 };
  assert.throws(() => assertRemoteWritePermission(task, ['a.ts', 'b.ts'], operation), /permission-required/);
});
