import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../server/store';
import { BridgeEngine } from '../server/engine';
import { createDotProvider, WORKSPACE_ENV } from '../server/provider';
import { createMcpServer } from '../server/mcp-server';
import { sourceHash } from '../server/local-files';
import { permissionState } from '../shared/permissions';
import { withDispatch } from '../shared/machine';
import { assertRemoteWritePermission } from '../server/remote-client';
import { pendingPermissions, permissionCurrent } from '../shared/permissions';
import { toolInputSchemas } from '../shared/mcp';
import { ProviderEventSchema, type ProviderEvent } from '@getpaseo/plugin/server/provider';

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-permissions-')));
  const store = await BridgeStore.open(dir), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 });
  await engine.init();
  const life = new AbortController();
  const provider = createDotProvider({ engine: async () => engine, tick: async () => {}, signal: life.signal, pollMs: 5 });
  const events: ProviderEvent[] = [];
  const connection = await provider.connect({ versions: [1], capabilities: ['prompt.message', 'session.persistence', 'permission'] });
  connection.onEvent(e => { ProviderEventSchema.parse(e); events.push(e); });
  const config = { cwd: dir, env: { [WORKSPACE_ENV]: 'ws' }, mcpServers: {}, settings: {}, persist: true };
  await connection.send({ type: 'session.open', requestId: randomUUID(), sessionId: 'chat', config, history: 'replay' });
  await connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: { clientMessageId: randomUUID(), delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Please update the files' }] } } });
  await store.mutate(d => { d.tasks[0] = withDispatch(d.tasks[0], Date.now()); });
  const task = engine.tasks()[0];
  const identity = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId };
  await engine.claimTask(identity);
  const request = { ...identity, requestId: randomUUID(), userMessageSeq: task.userMessageSeq, title: '修改文件', description: '接入用量估算', scope: { toolName: 'apply_dot_changes', action: '修改两个文件，接入估算账本', targets: ['one.ts'], operation: { kind: 'files' as const, operationId: randomUUID(), changes: [{ path: 'one.ts', expectedSha256: null as string | null, contentSha256: sourceHash('a') as string | null }] } } };
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(fn()); };
  t.after(async () => { life.abort(); await connection.close(); engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, engine, connection, events, identity, request, wait, config, provider };
}

test('native permission approval is scoped, durable and wakes Dot without finishing its round', async t => {
  const h = await fixture(t);
  await h.engine.requestPermission(h.request);
  await h.wait(() => h.events.some(e => e.type === 'session.permission'));
  const event = h.events.find(e => e.type === 'session.permission'); assert.ok(event?.type === 'session.permission');
  assert.match(event.request.description!, /one.ts/);
  assert.match(event.request.description!, /ChatGPT/);
  assert.equal(h.engine.task(h.identity.taskId).status, 'waiting_user');
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await assert.rejects(h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: 1, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] }), /permission/);
  await h.connection.send({ type: 'session.permission', sessionId: 'chat', permissionId: event.request.id, response: { behavior: 'allow' } });
  await h.wait(() => h.events.some(e => e.type === 'session.permission_resolved'));
  await h.wait(() => h.events.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.detail.type === 'plain_text' && e.item.detail.label === '已记录你的授权决定，等待 Dot 继续处理。'));
  const task = h.engine.task(h.identity.taskId), p = task.permissions[0];
  assert.equal(p.status, 'approved'); assert.equal(p.decisionMessageSeq, task.userMessageSeq);
  assert.match(task.messages.at(-1)!.body, /one.ts/);
  assert.equal(h.store.read().events.at(-1)!.data.messageSeq, task.messageSeq);
  const count = task.messages.length;
  await h.connection.send({ type: 'session.permission', sessionId: 'chat', permissionId: event.request.id, response: { behavior: 'allow' } });
  assert.equal(h.engine.task(task.id).messages.length, count);
  assert.equal((await h.engine.requestPermission(h.request)).status, 'approved');
  await assert.rejects(h.engine.requestPermission({ ...h.request, scope: { ...h.request.scope, targets: ['other.ts'] } }), /duplicate-mismatch/);
  await assert.rejects(h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'other.ts', expectedSha256: null, content: 'a' }] }), /permission/);
  await h.engine.applyLocalFiles({ ...h.identity, operationId: h.request.scope.operation.operationId, userMessageSeq: task.userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] });
});

test('pending requests replay on reconnect; stop invalidates buttons and stale approvals fail', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  await h.wait(() => h.events.some(e => e.type === 'session.permission'));
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  const second = await h.provider.connect({ versions: [1], capabilities: ['permission'] }); t.after(() => second.close());
  const replay: ProviderEvent[] = []; second.onEvent(e => replay.push(e));
  await second.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config: h.config, persistence: saved.persistence, history: 'skip' });
  assert.ok(replay.some(e => e.type === 'session.permission'));
  const task = h.engine.task(h.identity.taskId);
  await h.engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
  await h.wait(() => h.events.some(e => e.type === 'session.permission_resolved'));
  assert.equal(h.engine.task(task.id).permissions[0].status, 'expired');
  await assert.rejects(h.engine.respondPermission({ taskId: task.id, requestId: h.request.requestId, decision: 'approved' }), /permission/);
});

test('denial is delivered to Dot and platform rejection never fabricates a platform approval', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  const denied = await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'denied' });
  assert.equal(denied.status, 'denied');
  await assert.rejects(h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' }), /permission/);
  assert.match(h.engine.task(h.identity.taskId).messages.at(-1)!.body, /拒绝/);
  await assert.rejects(h.engine.reportPermissionBlocked({ ...h.identity, requestId: h.request.requestId, reason: 'Platform refused' }), /permission/);
});

test('approved request can become a visible platform handoff, and replies do not claim platform approval', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  await h.engine.reportPermissionBlocked({ ...h.identity, requestId: h.request.requestId, reason: 'Additional confirmation required by ChatGPT' });
  await h.wait(() => h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text.includes('https://chatgpt.com/dots/home')));
  assert.equal(h.engine.task(h.identity.taskId).permissions[0].status, 'approved');
  assert.ok(h.engine.task(h.identity.taskId).permissions[0].platformBlock);
  for (const event of h.events.filter(e => e.type === 'session.permission')) {
    assert.ok(event.type === 'session.permission');
    await h.wait(() => h.events.some(e => e.type === 'session.permission_resolved' && e.permissionId === event.request.id));
  }
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
});

test('new instructions expire pending permission and refuse stale requests', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  const task = h.engine.task(h.identity.taskId);
  await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Change scope first', kind: 'answer' });
  assert.equal(h.engine.task(task.id).permissions[0].status, 'expired');
  await assert.rejects(h.engine.respondPermission({ taskId: task.id, requestId: h.request.requestId, decision: 'approved' }), /permission-stale/);
  await assert.rejects(h.engine.requestPermission({ ...h.request, requestId: randomUUID() }), /permission-stale/);
});

test('native responses cannot widen input or cross conversations; conflicting clicks serialize', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  await h.wait(() => h.events.some(e => e.type === 'session.permission'));
  const e = h.events.find(e => e.type === 'session.permission'); assert.ok(e?.type === 'session.permission');
  await assert.rejects(h.connection.send({ type: 'session.permission', sessionId: 'chat', permissionId: e.request.id, response: { behavior: 'allow', updatedInput: { scope: { targets: ['everything'] } } } }), /scope/);
  await assert.rejects(h.connection.send({ type: 'session.permission', sessionId: 'chat', permissionId: randomUUID(), response: { behavior: 'allow' } }), /conversation/);
  assert.equal(h.engine.task(h.identity.taskId).permissions[0].status, 'pending');
  const results = await Promise.allSettled((['approved', 'denied'] as const).map(decision => h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.engine.task(h.identity.taskId).messages.filter(m => m.kind === 'answer').length, 1);
});

test('file approval cannot authorize attachments; attachment names remain scoped', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  const upload = { id: h.identity.taskId, roundId: h.identity.roundId, connectionId: h.identity.connectionId, operationId: randomUUID(), actor: 'dot' as const, name: 'report.txt', mediaType: 'text/plain', encoding: 'utf8' as const, content: 'report' };
  await assert.rejects(h.engine.uploadAttachment(upload), /permission-required/);
  const request = { ...h.request, requestId: randomUUID(), userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, scope: { toolName: 'upload_dot_attachment', action: 'Deliver report', targets: ['report.txt'], operation: { kind: 'attachment' as const, operationId: upload.operationId, name: upload.name, mediaType: upload.mediaType, size: Buffer.byteLength(upload.content), sha256: sourceHash(upload.content) } } };
  await h.engine.requestPermission(request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'approved' });
  await assert.rejects(h.engine.uploadAttachment({ ...upload, name: 'other.txt' }), /permission-required/);
  await assert.rejects(h.engine.uploadAttachment({ ...upload, content: 'changed bytes' }), /permission-required/);
  await assert.rejects(h.engine.uploadAttachment({ ...upload, operationId: randomUUID() }), /permission-required/);
  const result = await h.engine.uploadAttachment(upload);
  assert.equal(result.attachment.name, 'report.txt');
  assert.deepEqual(await h.engine.uploadAttachment(upload), result);
  await assert.rejects(h.engine.uploadAttachment({ ...upload, operationId: randomUUID() }), /permission-required/);
});

test('permissions survive disk reopen; v8 migration preserves original bytes', async t => {
  const h = await fixture(t); await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  await h.engine.reportPermissionBlocked({ ...h.identity, requestId: h.request.requestId, reason: 'Platform requires confirmation' });
  await h.connection.close(); h.engine.dispose(); await h.store.dispose();
  const reopened = await BridgeStore.open(h.dir);
  assert.equal(reopened.loadError, null);
  assert.deepEqual(reopened.read().tasks[0].permissions, h.engine.task(h.identity.taskId).permissions);
  const legacy = JSON.parse(await readFile(reopened.file, 'utf8'));
  await reopened.dispose();
  legacy.version = 8; delete legacy.tasks[0].permissions;
  const original = JSON.stringify(legacy);
  await writeFile(h.store.file, original);
  const migrated = await BridgeStore.open(h.dir);
  try {
    assert.equal(migrated.loadError, null);
    assert.equal(migrated.read().version, 10);
    assert.deepEqual(migrated.read().tasks[0].permissions, []);
    assert.equal(await readFile(join(h.dir, 'state.v8.json'), 'utf8'), original);
    assert.equal(migrated.read().tasks[0].messages.length, legacy.tasks[0].messages.length);
  } finally { await migrated.dispose(); }
});

test('authenticated MCP requests and reports permissions but cannot grant them', async t => {
  const h = await fixture(t);
  const server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const rpc = async (method: string, params: unknown, authorized = true) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${h.engine.mcpToken()}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await rpc('tools/call', { name: 'request_dot_permission', arguments: h.request }, false)).status, 401);
  const listed = await rpc('tools/list', {});
  assert.ok(listed.data.result.tools.some((tool: { name: string }) => tool.name === 'request_dot_permission'));
  assert.ok(!listed.data.result.tools.some((tool: { name: string }) => /respond.*permission|approve.*permission/.test(tool.name)));
  const request = await rpc('tools/call', { name: 'request_dot_permission', arguments: h.request });
  assert.ok(!request.data.error && !request.data.result.isError);
  await h.wait(() => h.events.some(e => e.type === 'session.permission'));
  const forged = await rpc('tools/call', { name: 'request_dot_permission', arguments: { ...h.request, decision: 'approved' } });
  assert.ok(forged.data.error || forged.data.result.isError);
  assert.equal(h.engine.task(h.identity.taskId).permissions[0].status, 'pending');
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  const blocked = await rpc('tools/call', { name: 'report_dot_permission_blocked', arguments: { ...h.identity, requestId: h.request.requestId, reason: 'Platform confirmation needed' } });
  assert.ok(!blocked.data.error && !blocked.data.result.isError);
  const fetched = await rpc('tools/call', { name: 'get_dot_task', arguments: { connectionId: h.identity.connectionId, taskId: h.identity.taskId } });
  assert.match(JSON.stringify(fetched.data), /Platform confirmation needed/);
  assert.match(JSON.stringify(fetched.data), /permissionInstructions/);
});

test('mutation approval binds bytes, action and operation id, is consumed once, and exact replay is safe', async t => {
  const h = await fixture(t);
  await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  const input = { ...h.identity, operationId: h.request.scope.operation.operationId, userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] };
  await assert.rejects(h.engine.applyLocalFiles({ ...input, operationId: randomUUID() }), /permission-required/);
  await assert.rejects(h.engine.applyLocalFiles({ ...input, changes: [{ ...input.changes[0], content: 'different bytes' }] }), /permission-required/);
  const receipt = await h.engine.applyLocalFiles(input);
  const task = h.engine.task(h.identity.taskId);
  assert.equal(permissionState(task, task.permissions[0]), 'consumed');
  assert.deepEqual(await h.engine.applyLocalFiles(input), receipt);
  await assert.rejects(h.engine.applyLocalFiles({ ...input, operationId: randomUUID(), changes: [{ path: 'one.ts', expectedSha256: sourceHash('a'), content: null }] }), /permission-required/);
  assert.equal(await readFile(join(h.dir, 'one.ts'), 'utf8'), 'a');
});

test('denial, platform block and expired approval survive ordinary follow-ups until explicit renewed approval', async t => {
  for (const decision of ['denied', 'approved', 'platform-blocked'] as const) {
    const h = await fixture(t);
    await h.engine.requestPermission(h.request);
    await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: decision === 'denied' ? 'denied' : 'approved' });
    if (decision === 'platform-blocked') await h.engine.reportPermissionBlocked({ ...h.identity, requestId: h.request.requestId, reason: 'Synthetic platform refusal' });
    let task = h.engine.task(h.identity.taskId);
    await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Why is this needed?', kind: 'answer' });
    const input = { ...h.identity, operationId: h.request.scope.operation.operationId, userMessageSeq: h.engine.task(task.id).userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] };
    await assert.rejects(h.engine.applyLocalFiles(input), /permission-required/);
    task = h.engine.task(task.id);
    assert.equal(permissionState(task, task.permissions[0]), decision === 'denied' ? 'denied' : 'expired');
    const next = { ...h.request, requestId: randomUUID(), userMessageSeq: task.userMessageSeq };
    await h.engine.requestPermission(next);
    await h.engine.respondPermission({ taskId: task.id, requestId: next.requestId, decision: 'approved' });
    assert.equal((await h.engine.applyLocalFiles({ ...input, userMessageSeq: h.engine.task(task.id).userMessageSeq })).status, 'applied');
  }
});

test('file and directory read requests enforce pending, denied, scoped approval and expiration', async t => {
  for (const toolName of ['read_dot_file', 'list_dot_files']) {
    const h = await fixture(t);
    await writeFile(join(h.dir, 'one.ts'), 'synthetic file');
    const request = { ...h.request, scope: { toolName, action: 'Read synthetic data', targets: [toolName === 'list_dot_files' ? '/' : 'one.ts'] } };
    const read = () => toolName === 'read_dot_file' ? h.engine.readLocalFile({ ...h.identity, path: 'one.ts' }) : h.engine.listLocalFiles({ ...h.identity, directory: '', offset: 0 });
    await h.engine.requestPermission(request);
    assert.throws(read, /permission-required/);
    await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'denied' });
    assert.throws(read, /permission-required/);
    let task = h.engine.task(h.identity.taskId);
    await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Please ask again with that scope', kind: 'answer' });
    assert.throws(read, /permission-required/);
    const next = { ...request, requestId: randomUUID(), userMessageSeq: h.engine.task(task.id).userMessageSeq };
    await h.engine.requestPermission(next);
    await h.engine.respondPermission({ taskId: task.id, requestId: next.requestId, decision: 'approved' });
    assert.doesNotThrow(read); assert.doesNotThrow(read);
    if (toolName === 'read_dot_file') assert.throws(() => h.engine.readLocalFile({ ...h.identity, path: 'other.ts' }), /permission-required/);
    else assert.throws(() => h.engine.listLocalFiles({ ...h.identity, directory: 'other', offset: 0 }), /permission-required/);
    task = h.engine.task(task.id);
    await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'One more question', kind: 'answer' });
    assert.throws(read, /permission-required/);
  }
});

test('workspace diff reads cannot bypass file denial or renew it through a follow-up; an explicit review grant is separate', async t => {
  const h = await fixture(t);
  const request = { ...h.request, scope: { toolName: 'read_dot_file', action: 'Read', targets: ['one.ts'] } };
  const review = () => h.engine.readLocalWorkspaceChanges({ ...h.identity, offset: 0 });
  await h.engine.requestPermission(request);
  await assert.rejects(review(), /permission-required/);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'denied' });
  await assert.rejects(review(), /permission-required/);
  let task = h.engine.task(h.identity.taskId);
  await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Review local changes', kind: 'answer' });
  await assert.rejects(review(), /permission-required/);
  task = h.engine.task(task.id);
  const fresh = { ...request, requestId: randomUUID(), userMessageSeq: task.userMessageSeq, scope: { toolName: 'read_dot_workspace_changes', action: 'Review Git diffs', targets: ['/'] } };
  await h.engine.requestPermission(fresh);
  await h.engine.respondPermission({ taskId: task.id, requestId: fresh.requestId, decision: 'approved' });
  assert.equal((await review()).isGitRepository, false);
  assert.throws(() => h.engine.readLocalFile({ ...h.identity, path: 'one.ts' }), /permission-required/);
});

test('attachment read aliases cannot bypass denial and local UI can still read its own attachment', async t => {
  const h = await fixture(t);
  const { attachment } = await h.engine.uploadAttachment({ id: h.identity.taskId, roundId: h.identity.roundId, connectionId: h.identity.connectionId, operationId: randomUUID(), actor: 'dot', name: 'test.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'synthetic' });
  const request = { ...h.request, userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, scope: { toolName: 'read_dot_attachment', action: 'Read synthetic attachment', targets: [attachment.id] } };
  await h.engine.requestPermission(request);
  await assert.rejects(h.engine.readAttachment(h.identity.taskId, attachment.id, h.identity.connectionId), /permission-required/);
  await assert.rejects(h.engine.readAttachmentChunk(h.identity.taskId, attachment.id, 0, h.identity.connectionId), /permission-required/);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'denied' });
  await assert.rejects(h.engine.readAttachmentChunk(h.identity.taskId, attachment.id, 0, h.identity.connectionId), /permission-required/);
  assert.equal((await h.engine.readAttachment(h.identity.taskId, attachment.id)).content, 'synthetic');
});

test('read-only and external approvals cannot authorize writes, including after an ordinary follow-up', async t => {
  for (const toolName of ['read_dot_file', 'list_dot_files', 'external_tool', 'bridge-mutation']) {
    const h = await fixture(t);
    const request = { ...h.request, scope: { toolName, action: 'Only the stated operation', targets: [toolName === 'list_dot_files' ? '/' : 'one.ts'] } };
    await h.engine.requestPermission(request);
    await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'approved' });
    const write = (path: string) => h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, changes: [{ path, expectedSha256: null, content: 'a' }] });
    const upload = () => h.engine.uploadAttachment({ ...h.identity, id: h.identity.taskId, operationId: randomUUID(), actor: 'dot', name: 'one.ts', mediaType: 'text/plain', encoding: 'utf8', content: 'a' });
    const chunk = () => h.engine.uploadAttachmentChunk({ ...h.identity, operationId: randomUUID(), name: 'one.ts', mediaType: 'text/plain', size: 1, sha256: sourceHash('a'), index: 0, content: 'YQ==' });
    await assert.rejects(write('one.ts'), /permission-required/);
    await assert.rejects(write('unapproved.ts'), /permission-required/);
    await assert.rejects(upload(), /permission-required/);
    await assert.rejects(chunk(), /permission-required/);
    const task = h.engine.task(h.identity.taskId);
    await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'What did you find?', kind: 'answer' });
    await assert.rejects(write('one.ts'), /permission-required/);
    await assert.rejects(upload(), /permission-required/);
    await assert.rejects(chunk(), /permission-required/);
    const mutation = { ...h.request, requestId: randomUUID(), userMessageSeq: h.engine.task(task.id).userMessageSeq };
    await h.engine.requestPermission(mutation);
    await h.engine.respondPermission({ taskId: task.id, requestId: mutation.requestId, decision: 'approved' });
    assert.equal((await h.engine.applyLocalFiles({ ...h.identity, operationId: mutation.scope.operation.operationId, userMessageSeq: h.engine.task(task.id).userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] })).status, 'applied');
    await assert.rejects(readFile(join(h.dir, 'unapproved.ts')), { code: 'ENOENT' });
  }
});

test('external attachment-read approval cannot supersede denial or authorize either attachment read tool', async t => {
  const h = await fixture(t);
  const { attachment } = await h.engine.uploadAttachment({ ...h.identity, id: h.identity.taskId, operationId: randomUUID(), actor: 'dot', name: 'test.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'synthetic' });
  const request = { ...h.request, scope: { toolName: 'read_dot_attachment', action: 'Read this attachment', targets: [attachment.id] } };
  await h.engine.requestPermission(request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'denied' });
  let task = h.engine.task(h.identity.taskId);
  await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Use the external tool instead', kind: 'answer' });
  const external = { ...request, requestId: randomUUID(), userMessageSeq: h.engine.task(task.id).userMessageSeq, scope: { ...request.scope, toolName: 'attachment-read', action: 'External tool only' } };
  await h.engine.requestPermission(external);
  await h.engine.respondPermission({ taskId: task.id, requestId: external.requestId, decision: 'approved' });
  task = h.engine.task(task.id);
  await assert.rejects(h.engine.readAttachment(task.id, attachment.id, h.identity.connectionId), /permission-required/);
  await assert.rejects(h.engine.readAttachmentChunk(task.id, attachment.id, 0, h.identity.connectionId), /permission-required/);
  assert.equal(permissionState(task, task.permissions[0]), 'denied');
  assert.equal((await h.engine.readAttachment(task.id, attachment.id)).content, 'synthetic');
  const renewed = { ...request, requestId: randomUUID(), userMessageSeq: task.userMessageSeq, scope: { ...request.scope, toolName: 'read_dot_attachment_chunk' } };
  await h.engine.requestPermission(renewed);
  await h.engine.respondPermission({ taskId: task.id, requestId: renewed.requestId, decision: 'approved' });
  assert.equal((await h.engine.readAttachment(task.id, attachment.id, h.identity.connectionId)).content, 'synthetic');
  assert.equal(Buffer.from((await h.engine.readAttachmentChunk(task.id, attachment.id, 0, h.identity.connectionId)).content, 'base64').toString(), 'synthetic');
});

test('v9 migration expires unbound approvals and blocks reuse after reopen', async t => {
  const h = await fixture(t);
  await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  await h.connection.close(); h.engine.dispose(); await h.store.dispose();
  const legacy = JSON.parse(await readFile(h.store.file, 'utf8'));
  legacy.version = 9;
  delete legacy.tasks[0].permissions[0].scope.operation;
  delete legacy.tasks[0].permissions[0].consumedAt;
  const original = JSON.stringify(legacy);
  await writeFile(h.store.file, original);
  const store = await BridgeStore.open(h.dir);
  try {
    assert.equal(store.loadError, null);
    assert.equal(store.read().tasks[0].permissions[0].status, 'expired');
    assert.equal(await readFile(join(h.dir, 'state.v9.json'), 'utf8'), original);
    const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
    await assert.rejects(engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: engine.task(h.identity.taskId).userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] }), /permission-required/);
    engine.dispose();
  } finally { await store.dispose(); }
});

test('explicit local close releases a claimed slot, expires buttons and fences late calls across recovery', async t => {
  const h = await fixture(t);
  const close = () => ({ id: h.identity.taskId, roundId: h.identity.roundId, revision: h.engine.task(h.identity.taskId).revision, operationId: randomUUID() });
  await assert.rejects(h.engine.closeLocal(close()), /stop-rejected/);
  await h.engine.requestPermission(h.request);
  await h.engine.cancelRequest({ id: h.identity.taskId, revision: h.engine.task(h.identity.taskId).revision, operationId: randomUUID() });
  const input = close();
  const stopped = await h.engine.closeLocal(input);
  assert.deepEqual(await h.engine.closeLocal(input), stopped);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.permissions[0].status, 'expired');
  assert.ok(stopped.rounds[0].stop.localClosedAt); assert.equal(stopped.rounds[0].stop.reported, false);
  assert.equal(h.engine.slotsUsed(), 0);
  await assert.rejects(h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: stopped.userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] }), /claim-required/);
  assert.throws(() => h.engine.readLocalFile({ ...h.identity, path: 'one.ts' }), /claim-required/);
  await assert.rejects(h.engine.uploadAttachment({ id: stopped.id, ...h.identity, operationId: randomUUID(), actor: 'dot', name: 'late.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'late' }), /stop requested/);
  const late = { ...h.identity, kind: 'text' as const, updateId: randomUUID(), summary: 'late result', baseSha: null, headSha: null, branch: null, checks: [], prUrl: null, processedThroughSeq: stopped.userMessageSeq };
  await h.engine.processResult(late);
  assert.equal(h.engine.task(stopped.id).status, 'stopped'); assert.equal(h.engine.slotsUsed(), 0);
  await h.engine.recover(); assert.equal(h.engine.slotsUsed(), 0);
  const next = await h.engine.retryRound({ id: stopped.id, revision: h.engine.task(stopped.id).revision, operationId: randomUUID() });
  assert.notEqual(next.currentRoundId, h.identity.roundId);
  await assert.rejects(h.engine.closeLocal({ ...close(), revision: next.revision }), /round-stale/);
  await h.engine.processResult({ ...late, updateId: randomUUID() });
  assert.equal(h.engine.task(stopped.id).status, 'queued');
  await h.engine.reportProgress({ ...h.identity, updateId: randomUUID(), kind: 'stopped', note: 'Remote stopped later', processedThroughSeq: stopped.userMessageSeq });
  assert.equal(h.engine.task(stopped.id).status, 'queued');
  assert.equal(h.engine.task(stopped.id).rounds[0].stop.reported, true);
});

test('platform refusal before a local request is visible without manufacturing approval or local buttons', async t => {
  const h = await fixture(t);
  const { connectionId, taskId, roundId, requestId, ...intent } = h.request;
  const input = toolInputSchemas.report_dot_permission_blocked.parse({ connectionId, taskId, roundId, requestId, intent, reason: 'Platform refused before local confirmation' });
  const blocked = await h.engine.reportPermissionBlocked(input);
  assert.notEqual(blocked.status, 'approved');
  assert.equal(blocked.platformBlock?.reason, input.reason);
  const task = h.engine.task(taskId);
  assert.deepEqual(pendingPermissions(task), []);
  assert.match(task.messages.at(-1)!.body, /Platform refused before local confirmation/);
  assert.doesNotMatch(task.messages.at(-1)!.body, /Paseo 已记录你的允许/);
  await assert.rejects(h.engine.respondPermission({ taskId, requestId, decision: 'approved' }), /permission/);
  await assert.rejects(h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] }), /permission/);
  assert.deepEqual(await h.engine.reportPermissionBlocked(input), blocked);
  await assert.rejects(h.engine.reportPermissionBlocked({ ...input, intent: { ...intent, scope: { ...intent.scope, targets: ['outside.ts'] } } }), /duplicate-mismatch/);
  await assert.rejects(h.engine.requestPermission({ ...h.request, requestId: randomUUID() }), /permission-required/);
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.ok(!h.events.some(e => e.type === 'session.permission'));
});

test('late progress cannot show an obsolete permission question after a decision was processed', async t => {
  const h = await fixture(t);
  await h.engine.requestPermission(h.request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: h.request.requestId, decision: 'approved' });
  const task = h.engine.task(h.identity.taskId);
  await h.engine.reportProgress({ ...h.identity, updateId: randomUUID(), kind: 'running', note: 'Continuing approved work', processedThroughSeq: task.userMessageSeq });
  await h.engine.reportProgress({ ...h.identity, updateId: randomUUID(), kind: 'waiting_user', note: 'Old permission question', processedThroughSeq: h.request.userMessageSeq });
  await h.wait(() => h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'Old permission question'));
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(h.engine.task(task.id).status, 'running');
});

test('platform block replaces pending local buttons and rejects stale or denied scopes', async t => {
  const h = await fixture(t);
  await h.engine.requestPermission(h.request);
  await h.wait(() => h.events.some(e => e.type === 'session.permission'));
  const blocked = await h.engine.reportPermissionBlocked({ ...h.identity, requestId: h.request.requestId, reason: 'Platform refuses this operation' });
  assert.equal(blocked.status, 'pending');
  await h.wait(() => h.events.some(e => e.type === 'session.permission_resolved'));
  const task = h.engine.task(h.identity.taskId);
  await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), body: 'Use a different scope', kind: 'answer' });
  const { requestId: _requestId, connectionId: _connectionId, taskId: _taskId, roundId: _roundId, ...intent } = h.request;
  await assert.rejects(h.engine.reportPermissionBlocked({ ...h.identity, requestId: randomUUID(), reason: 'Old rejection', intent }), /permission-stale/);
  const request = { ...h.request, requestId: randomUUID(), userMessageSeq: h.engine.task(task.id).userMessageSeq };
  await h.engine.requestPermission(request);
  await h.engine.respondPermission({ taskId: task.id, requestId: request.requestId, decision: 'denied' });
  await assert.rejects(h.engine.reportPermissionBlocked({ ...h.identity, requestId: request.requestId, reason: 'Do not replace denial' }), /permission-required/);
});
