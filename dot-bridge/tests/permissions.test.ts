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
import { withDispatch } from '../shared/machine';
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
  const request = { ...identity, requestId: randomUUID(), userMessageSeq: task.userMessageSeq, title: '修改文件', description: '接入用量估算', scope: { toolName: 'apply_dot_changes', action: '修改两个文件，接入估算账本', targets: ['one.ts', 'two.ts'] } };
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
  await h.engine.applyLocalFiles({ ...h.identity, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'one.ts', expectedSha256: null, content: 'a' }] });
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
  const request = { ...h.request, requestId: randomUUID(), userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, scope: { toolName: 'upload_dot_attachment', action: 'Deliver report', targets: ['report.txt'] } };
  await h.engine.requestPermission(request);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'approved' });
  await assert.rejects(h.engine.uploadAttachment({ ...upload, name: 'other.txt' }), /permission-required/);
  assert.equal((await h.engine.uploadAttachment(upload)).attachment.name, 'report.txt');
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
    assert.equal(migrated.read().version, 9);
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
