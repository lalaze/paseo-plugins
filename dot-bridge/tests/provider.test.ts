import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ProviderEvent, ProviderPersistence, ProviderPrompt, ProviderSessionConfig } from '@getpaseo/plugin/server/provider';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { BridgeEngine } from '../server/engine';
import { createGit } from '../server/git';
import { BridgeStore } from '../server/store';
import { createDotProvider, promptContents, WORKSPACE_ENV } from '../server/provider';
import { applyLocalChanges, canonicalWorkspace } from '../server/local-files';
import { createMcpServer } from '../server/mcp-server';
import { ATTACHMENT_CHUNK_BYTES } from '../shared/attachments';
import { withDispatch } from '../shared/machine';

const config: ProviderSessionConfig = { cwd: '/repo', env: { [WORKSPACE_ENV]: 'ws-test' }, mcpServers: {}, settings: {}, persist: true };
const prompt = (text: string, id: string = randomUUID()): ProviderPrompt => ({ clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } });
async function fixture(t: TestContext, workspace = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-provider-'));
  if (workspace) await mkdir(join(dir, 'workspace'));
  const cwd = workspace ? canonicalWorkspace(join(dir, 'workspace')) : config.cwd;
  const store = await BridgeStore.open(dir);
  const engine = new BridgeEngine({ store, git: createGit({ cacheRoot: join(dir, 'git') }), getMaxInFlight: () => 2 });
  await engine.init();
  const lifecycle = new AbortController();
  const provider = createDotProvider({ engine: async () => engine, tick: async () => {}, signal: lifecycle.signal, pollMs: 5 });
  const events: ProviderEvent[] = [];
  const connect = async () => {
    const connection = await provider.connect({ versions: [1], capabilities: ['prompt.message', 'prompt.image', 'prompt.steer', 'session.persistence', 'timeline.plugin'] });
    connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
    return connection;
  };
  t.after(async () => { lifecycle.abort(); engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const connection = await connect();
  const openSession = async (sid = 'chat', persistence?: ProviderPersistence) => {
    await connection.send({ type: 'session.open', requestId: randomUUID(), sessionId: sid, config: { ...config, cwd }, history: 'replay', persistence });
  };
  const claim = async () => {
    let task = engine.tasks()[0]!;
    if (task.status === 'queued') await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
    task = engine.task(task.id);
    await engine.claimTask({ taskId: task.id, roundId: task.currentRoundId, connectionId: engine.connection().id });
    return engine.task(task.id);
  };
  const result = async (summary: string) => {
    const task = await claim();
    await engine.processResult({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'text', baseSha: null, headSha: null, branch: null, prUrl: null, summary, checks: [], processedThroughSeq: task.userMessageSeq });
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Expected provider event did not arrive');
  };
  return { dir, cwd, store, engine, connection, connect, openSession, claim, result, events, wait };
}

/** Calls Bridge tools the way Dot does, over authenticated MCP HTTP. */
async function bridge(t: TestContext, engine: BridgeEngine) {
  const server = createMcpServer({ engine, host: '127.0.0.1', port: 0, getToken: () => engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  return async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engine.mcpToken()}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as { error?: unknown; result?: { content: Array<{ text: string }> } };
    return body.result ? JSON.parse(body.result.content[0]!.text) : { error: body.error };
  };
}

const cards = (events: ProviderEvent[]) => events.flatMap(e => (e.type === 'timeline.item' && e.item.type === 'tool_call' ? [e.item] : []));
const label = (item: { detail: { type: string; label?: string } } | undefined) => (item?.detail.type === 'plain_text' ? item.detail.label : undefined);

test('native prompts can exceed 16 archived files while individual messages remain bounded', async t => {
  const h = await fixture(t);
  const id = randomUUID();
  const files = Array.from({ length: 16 }, (_, i) => ({ name: `file-${i}.txt`, mediaType: 'text/plain', encoding: 'utf8' as const, content: `file ${i}` }));
  const promptInput = { id, operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws-test', cwd: h.cwd,
    body: 'Read these files', systemPrompt: '', attachments: files };
  const first = await h.engine.providerPrompt(promptInput);
  assert.equal(first.task.attachments.length, 16);
  const input = { ...promptInput, operationId: randomUUID(), clientMessageId: randomUUID(), attachments: [files[0]!] };
  const next = await h.engine.providerPrompt(input);
  assert.equal(next.task.attachments.length, 17);
  assert.equal((await h.engine.providerPrompt(input)).duplicate, true);
  assert.equal(h.engine.task(id).attachments.length, 17);
  assert.equal((await h.engine.readAttachment(id, first.task.attachments[0]!.id)).content, 'file 0');
  await assert.rejects(h.engine.providerPrompt({ ...input, operationId: randomUUID(), attachments: [...files, files[0]!] }), /attachment-batch-limit/);
});

test('native chat shows an unclaimed timeout and replaces it after a real claim', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Continue') });
  await h.store.mutate(draft => {
    const task = withDispatch(draft.tasks[0]!, Date.now());
    task.rounds[0]!.claimWait = { firstDeliveredAt: Date.now() - 120_000, lastWakeAt: Date.now(), retries: 3, timedOut: true };
    draft.tasks[0] = task;
  });
  await h.wait(() => cards(h.events).some(item => label(item)?.includes('自动补发已达上限')));
  assert.equal(h.events.some(e => e.type === 'session.turn' && e.state === 'completed'), false);
  await h.claim();
  await h.wait(() => label(cards(h.events).at(-1)) === 'Dot 已接单。');
});

test('MCP reads appear live, deduplicate task reads, and keep refused reads out of other connections', async t => {
  const h = await fixture(t, true); await h.openSession();
  await writeFile(join(h.cwd, 'main.ts'), 'export const n = 1;\n'); await mkdir(join(h.cwd, 'src'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Read the project') });
  const task = h.engine.tasks()[0]!, call = await bridge(t, h.engine);
  const identity = { taskId: task.id, connectionId: task.connectionId };
  await call('get_dot_task', identity); await call('get_dot_task', identity);
  await h.wait(() => cards(h.events).some(card => label(card) === '已读取你的消息'));
  assert.equal(cards(h.events).filter(card => label(card) === '已读取你的消息').length, 1);
  await h.claim();
  const args = { ...identity, roundId: task.currentRoundId };
  assert.ok((await call('read_dot_file', { ...args, path: '.env' })).error);
  assert.ok((await call('read_dot_file', { ...args, path: 'main.ts', connectionId: '0'.repeat(32) })).error);
  await call('list_dot_files', args); await call('read_dot_file', { ...args, path: 'main.ts' });
  await h.wait(() => cards(h.events).filter(card => card.name === 'Read').length === 2);
  const reads = cards(h.events).filter(card => card.name === 'Read');
  assert.deepEqual(reads.map(card => card.status), ['failed', 'completed']);
  assert.match(String(reads[0]!.error), /protected path/);
  assert.deepEqual(reads[1]!.detail, { type: 'read', filePath: 'main.ts' });
  const listing = cards(h.events).find(card => card.name === 'List');
  assert.deepEqual(listing?.detail, { type: 'plain_text', label: '.', text: 'main.ts\nsrc/', icon: 'search' });
  assert.equal(h.engine.task(task.id).messages.length, 1, 'Activity does not add stored chat messages');
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
});

test('applied create/update/delete cards replay journal diffs after restart and later user edits', async t => {
  const h = await fixture(t, true); await h.openSession();
  await writeFile(join(h.cwd, 'main.ts'), 'old\n'); await writeFile(join(h.cwd, 'obsolete.ts'), 'remove\n');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Update the project') });
  const task = await h.claim(), call = await bridge(t, h.engine);
  const args = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId };
  const main = await call('read_dot_file', { ...args, path: 'main.ts' });
  const obsolete = await call('read_dot_file', { ...args, path: 'obsolete.ts' });
  const apply = { ...args, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [
    { path: 'main.ts', expectedSha256: main.sha256, content: 'new\n' },
    { path: 'created.ts', expectedSha256: null, content: 'added\n' },
    { path: 'obsolete.ts', expectedSha256: obsolete.sha256, content: null },
  ] };
  assert.equal((await call('apply_dot_changes', apply)).status, 'applied');
  await h.wait(() => cards(h.events).filter(card => card.name === 'Edit').length === 3);
  const edits = cards(h.events).filter(card => card.name === 'Edit');
  assert.deepEqual(edits.map(card => card.detail), [
    { type: 'edit', filePath: 'main.ts', unifiedDiff: '@@ -1,1 +1,1 @@\n-old\n+new' },
    { type: 'edit', filePath: 'created.ts', unifiedDiff: '@@ -0,0 +1,1 @@\n+added' },
    { type: 'edit', filePath: 'obsolete.ts', unifiedDiff: '@@ -1,1 +0,0 @@\n-remove' },
  ]);
  await writeFile(join(h.cwd, 'main.ts'), 'later user edit\n');
  assert.equal((await call('apply_dot_changes', apply)).status, 'applied');
  assert.equal(await readFile(join(h.cwd, 'main.ts'), 'utf8'), 'later user edit\n');
  await h.result('Updated the project');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(cards(h.events).filter(card => card.name === 'Edit').length, 3);
  assert.ok(!h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text.includes('已应用到本地工作区')));
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  await h.connection.close(); h.engine.dispose(); await h.store.dispose();
  const store = await BridgeStore.open(h.dir), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const lifecycle = new AbortController();
  const provider = createDotProvider({ engine: async () => engine, tick: async () => {}, signal: lifecycle.signal, pollMs: 5 });
  const connection = await provider.connect({ versions: [1], capabilities: ['session.persistence', 'timeline.plugin'] });
  t.after(async () => { lifecycle.abort(); engine.dispose(); await store.dispose(); });
  const replay: ProviderEvent[] = []; connection.onEvent(event => { ProviderEventSchema.parse(event); replay.push(event); });
  await connection.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config: { ...config, cwd: h.cwd }, history: 'replay', persistence: saved.persistence });
  assert.deepEqual(cards(replay).filter(card => card.name === 'Edit'), edits);
  assert.equal(store.read().tasks[0]!.localChanges.length, 1);
});

test('conflicts and refused changes stay failed, while partial receipts show only files actually applied', async t => {
  const h = await fixture(t, true); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Create files') });
  const task = await h.claim(), call = await bridge(t, h.engine);
  const args = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, userMessageSeq: task.userMessageSeq };
  await writeFile(join(h.cwd, 'existing.ts'), 'user content');
  const conflictId = randomUUID();
  assert.equal((await call('apply_dot_changes', { ...args, operationId: conflictId, changes: [{ path: 'existing.ts', expectedSha256: null, content: 'replacement' }] })).status, 'conflict');
  const refusedId = randomUUID();
  assert.ok((await call('apply_dot_changes', { ...args, operationId: refusedId, changes: [{ path: '.env', expectedSha256: null, content: 'secret' }] })).error);
  const partial = { ...args, operationId: randomUUID(), changes: [
    { path: 'a.ts', expectedSha256: null, content: 'a\n' }, { path: 'b.ts', expectedSha256: null, content: 'b\n' },
  ] };
  // Simulate a crash after the first file was applied, before a receipt reached the engine.
  applyLocalChanges({ ...partial, dataDir: h.dir, root: h.cwd, at: Date.now() });
  const path = join(h.dir, 'local-changes', `${partial.operationId}.json`);
  const journal = JSON.parse(await readFile(path, 'utf8'));
  journal.finished = false; journal.receipt.files = journal.receipt.files.slice(0, 1);
  await writeFile(path, JSON.stringify(journal)); await rm(join(h.cwd, 'b.ts'));
  assert.equal((await call('apply_dot_changes', partial)).status, 'partial');
  await h.wait(() => cards(h.events).some(card => label(card) === '部分修改未应用'));
  const edits = cards(h.events).filter(card => card.name === 'Edit');
  assert.deepEqual(edits.map(card => card.detail), [{ type: 'edit', filePath: 'a.ts', unifiedDiff: '@@ -0,0 +1,1 @@\n+a' }]);
  const failed = cards(h.events).filter(card => card.status === 'failed');
  assert.equal(failed.length, 3);
  assert.match(String(failed.find(card => card.id.includes(conflictId))?.error), /File changed since read/);
  assert.match(String(failed.find(card => card.id.includes(refusedId))?.error), /protected path/);
  assert.match(String(failed.find(card => label(card) === '部分修改未应用')?.error), /Interrupted file operation/);
  assert.equal(await readFile(join(h.cwd, 'existing.ts'), 'utf8'), 'user content');
  await assert.rejects(readFile(join(h.cwd, 'b.ts')), { code: 'ENOENT' });
});

test('chunk uploads update one card, deduplicate chunks, finish with an attachment, and replay in order', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Send a file') });
  const task = await h.claim(), call = await bridge(t, h.engine);
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1, 42), operationId = randomUUID();
  const args = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, operationId,
    name: 'sample.bin', mediaType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const chunk = (index: number) => ({ ...args, index, content: bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES).toString('base64') });
  await call('get_dot_task', { taskId: task.id, connectionId: task.connectionId });
  const first = await call('upload_dot_attachment_chunk', chunk(1)); assert.equal(first.complete, false);
  await h.wait(() => cards(h.events).some(card => label(card) === '正在接收 sample.bin（1/2）'));
  const running = cards(h.events).find(card => label(card) === '正在接收 sample.bin（1/2）')!;
  assert.equal(running.status, 'running');
  assert.deepEqual(await call('upload_dot_attachment_chunk', chunk(1)), first);
  assert.equal((await call('upload_dot_attachment_chunk', chunk(0))).complete, true);
  await h.wait(() => cards(h.events).some(card => card.id === running.id && card.status === 'completed'));
  assert.equal((await call('upload_dot_attachment_chunk', chunk(0))).complete, true);
  await call('read_dot_attachment_chunk', { taskId: task.id, connectionId: task.connectionId, attachmentId: operationId, index: 0 });
  await h.result('Here is your file');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.deepEqual(cards(h.events).filter(card => card.id === running.id).map(card => card.status), ['running', 'completed']);
  assert.equal(h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'plugin').length, 1);
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  await h.connection.close(); const restored = await h.connect(), start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config, history: 'replay', persistence: saved.persistence });
  const timeline = h.events.slice(start).flatMap(e => e.type === 'timeline.item' ? [e.item] : []).filter(item => item.type !== 'tool_call' || !item.id.includes(':status:'));
  assert.deepEqual(timeline.map(item => item.type === 'tool_call' ? label(item) : item.type), [
    'user_message', '已读取你的消息', '已接收 sample.bin', 'plugin', '读取附件 sample.bin（1/2）', 'assistant_message',
  ]);
});

test('incomplete uploads stop spinning on completion or stop request and rejected uploads expose failure', async t => {
  for (const finish of ['complete', 'stop'] as const) {
    const h = await fixture(t); await h.openSession();
    await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Send a file') });
    const task = await h.claim(), call = await bridge(t, h.engine), operationId = randomUUID();
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1, 42);
    const args = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, operationId,
      name: 'unfinished.bin', mediaType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), index: 0, content: bytes.subarray(0, ATTACHMENT_CHUNK_BYTES).toString('base64') };
    await call('upload_dot_attachment_chunk', args);
    await h.wait(() => cards(h.events).some(card => label(card) === '正在接收 unfinished.bin（1/2）'));
    if (finish === 'complete') await h.result('Finished without the file');
    else await h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() });
    await h.wait(() => cards(h.events).some(card => card.id.includes(operationId) && card.status === 'canceled'));
    assert.ok((await call('upload_dot_attachment', { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, operationId: randomUUID(), name: 'rejected.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'too late' })).error);
    await h.wait(() => cards(h.events).some(card => label(card) === '接收 rejected.txt 失败' && card.status === 'failed'));
    assert.equal(h.engine.task(task.id).attachments.length, 0);
  }
});

test('missing or malformed journals omit diffs and activity observer failures preserve MCP results', async t => {
  const h = await fixture(t, true); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Create files') });
  const task = await h.claim(), call = await bridge(t, h.engine);
  const args = { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId };
  await h.connection.close();
  const apply = { ...args, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'a.ts', expectedSha256: null, content: 'a\n' }] };
  assert.equal((await call('apply_dot_changes', apply)).status, 'applied');
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  const path = join(h.dir, 'local-changes', `${apply.operationId}.json`);
  await writeFile(path, JSON.stringify({ changes: {}, before: [] }));
  const restored = await h.connect(), start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config: { ...config, cwd: h.cwd }, history: 'replay', persistence: saved.persistence });
  const edit = cards(h.events.slice(start)).find(card => card.name === 'Edit');
  assert.deepEqual(edit?.detail, { type: 'edit', filePath: 'a.ts' });
  assert.equal(edit?.status, 'completed');
  await rm(path); assert.equal(h.engine.changeContents(apply.operationId), null);
  assert.equal(h.engine.changeContents('../state'), null);
  t.mock.method(h.engine.activity, 'record', () => { throw new Error('observer failed'); });
  const errors = t.mock.method(console, 'error', () => {});
  const read = await call('read_dot_file', { ...args, path: 'a.ts' });
  assert.equal(read.content, 'a\n'); assert.equal(read.error, undefined);
  assert.ok((await call('read_dot_file', { ...args, path: '.env' })).error);
  assert.equal(errors.mock.calls.length, 2);
});

test('edit cards read the change journal once per session, not on every poll', async t => {
  const h = await fixture(t, true); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Create a file') });
  const task = await h.claim(), call = await bridge(t, h.engine);
  const journalReads = t.mock.method(h.engine, 'changeContents');
  await call('apply_dot_changes', { taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'a.ts', expectedSha256: null, content: 'a\n' }] });
  await h.wait(() => cards(h.events).some(card => card.name === 'Edit'));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(journalReads.mock.callCount(), 1);
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  const start = h.events.length;
  await h.connection.send({ type: 'session.open', sessionId: 'second', requestId: randomUUID(), config: { ...config, cwd: h.cwd }, history: 'replay', persistence: saved.persistence });
  assert.deepEqual(cards(h.events.slice(start)).filter(card => card.name === 'Edit').map(card => card.detail), [{ type: 'edit', filePath: 'a.ts', unifiedDiff: '@@ -0,0 +1,1 @@\n+a' }]);
  assert.equal(journalReads.mock.callCount(), 2);
});

test('native chat replies, automatically advances rounds, and replays without duplicate work', async t => {
  const h = await fixture(t); await h.openSession();
  const first = prompt('Remember apple');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: first });
  assert.equal(h.engine.tasks().length, 1);
  await h.result('I remember apple');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'I remember apple'));
  // Re-delivery is acknowledged, without starting another round or duplicating the user message.
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: first });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages.filter(m => m.author === 'user').length, 1);
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('What did I say?') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 2);
  assert.equal(h.engine.tasks()[0]!.messages.at(-1)!.body, 'What did I say?');
  await h.result('apple');
  await h.wait(() => h.events.filter(e => e.type === 'session.turn' && e.state === 'completed').length === 2);
  const opened = h.events.find(e => e.type === 'session.opened');
  assert.ok(opened?.type === 'session.opened');
  await h.connection.close();
  const restored = await h.connect(); const start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'restored', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  const texts = h.events.slice(start).flatMap(e => e.type === 'timeline.item' && (e.item.type === 'user_message' || e.item.type === 'assistant_message') ? [e.item.text] : []);
  assert.deepEqual(texts, ['Remember apple', 'I remember apple', 'What did I say?', 'apple']);
  assert.equal(h.engine.tasks().length, 1);
});

test('waiting_user allows an answer in the same round; cancel waits for remote acknowledgment', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Plan a trip') });
  const task = await h.claim();
  await h.engine.reportProgress({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'waiting_user', note: 'Which city?', processedThroughSeq: task.userMessageSeq });
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Boston') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages.at(-1)!.kind, 'answer');
  await h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() });
  assert.equal(h.engine.tasks()[0]!.rounds[0]!.stop.requested, true);
  assert.notEqual(h.engine.tasks()[0]!.status, 'stopped');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Next') });
  assert.ok(h.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'));
  const latest = h.engine.task(task.id);
  await h.engine.reportProgress({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'stopped', note: 'Stopped', processedThroughSeq: latest.userMessageSeq });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Try again') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 2);
  assert.equal(h.engine.tasks()[0]!.status, 'queued');
});

test('progress is visible before completion, updates the status card, and survives replay without duplicates', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Compare the options') });
  const task = await h.claim();
  const report = { taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'running' as const, note: 'Option A supports offline use; checking the remaining trade-offs.', processedThroughSeq: task.userMessageSeq };
  await h.engine.reportProgress(report);
  const progressEvents = () => h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === report.note);
  await h.wait(() => progressEvents().length === 1);
  assert.equal(h.engine.task(task.id).status, 'running');
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.status === 'running' && e.item.detail.type === 'plain_text' && e.item.detail.label === report.note));
  await h.engine.reportProgress(report);
  await h.result('Choose A for offline use.');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(progressEvents().length, 1);
  const opened = h.events.find(e => e.type === 'session.opened'); assert.ok(opened?.type === 'session.opened');
  await h.connection.close(); const restored = await h.connect(); const start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  assert.deepEqual(h.events.slice(start).flatMap(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' ? [e.item.text] : []), [report.note, 'Choose A for offline use.']);
  await restored.send({ type: 'session.prompt', sessionId: 'replay', prompt: prompt('Now compare cost') });
  const card = h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'tool_call').at(-1);
  assert.ok(card?.type === 'timeline.item' && card.item.type === 'tool_call' && card.item.detail.type === 'plain_text');
  assert.notEqual(card.item.detail.label, report.note, 'Do not reuse previous-round progress for a new prompt');
});

test('files are attached atomically, recover from disk, and invalid files create no task', async t => {
  const h = await fixture(t); await h.openSession();
  const path = join(h.dir, 'sample.txt'); await writeFile(path, 'synthetic attachment');
  const message = prompt('Read the file');
  assert.equal(message.input.type, 'message');
  if (message.input.type !== 'message') return;
  message.input.content.push({ type: 'uploaded_file', id: 'upload', fileName: 'sample.txt', mimeType: 'text/plain', size: 20, path });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: message });
  const task = h.engine.tasks()[0]!;
  assert.equal(task.attachments.length, 1);
  assert.equal((await h.engine.readAttachment(task.id, task.attachments[0]!.id)).content, 'synthetic attachment');
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'plugin'));
  await h.connection.close(); await h.store.dispose();
  const reopened = await BridgeStore.open(h.dir);
  assert.equal(reopened.read().tasks[0]!.provider?.clientMessageIds['1'], message.clientMessageId);
  await reopened.dispose();
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(promptContents(message), /1 MiB/);
});

test('concurrent prompt and interrupt cannot leave newly submitted work running', async t => {
  const h = await fixture(t); await h.openSession();
  await Promise.all([
    h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('queued') }),
    h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() }),
  ]);
  assert.equal(h.engine.tasks()[0]!.status, 'stopped');
});

test('stopping before Dot claims releases the slot and allows the next message in the same session', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('First hello') });
  await h.store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
  const first = h.engine.tasks()[0]!;
  assert.equal(h.engine.slotsUsed(), 1);
  await h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() });
  assert.equal(h.engine.task(first.id).status, 'stopped');
  assert.equal(h.engine.slotsUsed(), 0);
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Second hello') });
  assert.equal(h.engine.tasks().length, 1);
  assert.notEqual(h.engine.task(first.id).currentRoundId, first.currentRoundId);
  await h.result('Hello back');
  await h.wait(() => h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'Hello back'));
});

test('reconnect to active work resumes waiting without re-dispatching; workspace mismatch fails', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Long work') });
  const opened = h.events.find(e => e.type === 'session.opened'); assert.ok(opened?.type === 'session.opened');
  await h.connection.close(); const restored = await h.connect();
  await restored.send({ type: 'session.open', sessionId: 'again', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  assert.ok(h.events.some(e => e.type === 'session.turn' && e.sessionId === 'again' && e.state === 'started'));
  assert.equal(h.engine.tasks()[0]!.messages.length, 1);
  await restored.send({ type: 'session.open', sessionId: 'wrong', requestId: 'wrong', config: { ...config, cwd: '/other' }, history: 'replay', persistence: opened.persistence });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'wrong'));
  await h.result('Done after reconnect');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.sessionId === 'again' && e.state === 'completed'));
});

test('reused client identity with changed text is rejected without changing stored conversation', async t => {
  const h = await fixture(t); await h.openSession();
  const original = prompt('Original');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: original });
  await h.result('Done');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Changed', original.clientMessageId) });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages[0]!.body, 'Original');
  assert.ok(h.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'));
});

test('persistence refuses a missing committed task and invalid file input leaves no partial task', async t => {
  const h = await fixture(t);
  await h.connection.send({ type: 'session.open', sessionId: 'lost', requestId: 'lost', config, history: 'replay', persistence: { version: 1, data: { taskId: randomUUID(), cwd: config.cwd, workspaceId: 'ws-test', taskCreated: true } } });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'lost'));
  await h.openSession();
  const message = prompt('bad file');
  if (message.input.type !== 'message') return;
  message.input.content.push({ type: 'image', mimeType: 'image/png', data: 'invalid' });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: message });
  assert.equal(h.engine.tasks().length, 0);
});

test('steering an active Dot turn preserves the round, wakes Dot and deduplicates retries', async t => {
  const h = await fixture(t); await h.openSession();
  assert.ok(h.connection.capabilities.includes('prompt.steer'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Implement the feature') });
  const before = await h.claim();
  const started = h.events.find(e => e.type === 'session.turn' && e.state === 'started');
  assert.ok(started?.type === 'session.turn');
  const steer = { ...prompt('Only review the tests first'), delivery: 'steer' as const };
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: steer });
  const response = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === steer.clientMessageId);
  assert.ok(response?.type === 'session.prompt_result');
  assert.deepEqual(response.result, { type: 'steer', turnId: started.turnId });
  const task = h.engine.task(before.id);
  assert.equal(task.currentRoundId, before.currentRoundId);
  assert.equal(task.messages.at(-1)?.body, 'Only review the tests first');
  assert.equal(task.rounds.length, 1);
  assert.equal(h.store.read().events.at(-1)?.data.messageSeq, task.messageSeq);
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: steer });
  assert.equal(h.engine.task(before.id).messages.length, task.messages.length);
  assert.equal(h.events.filter(e => e.type === 'session.turn' && e.state === 'started').length, 1);
  await h.result('Reviewed the tests');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed' && e.turnId === started.turnId));
});

test('a reconnected active turn accepts an ordinary follow-up without starting duplicate work', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Start') });
  const before = await h.claim();
  const saved = h.events.find(e => e.type === 'session.persistence'); assert.ok(saved?.type === 'session.persistence');
  await h.connection.send({ type: 'session.close', sessionId: 'chat', requestId: randomUUID() });
  await h.openSession('restored', saved.persistence);
  const follow = prompt('Continue the existing request');
  await h.connection.send({ type: 'session.prompt', sessionId: 'restored', prompt: follow });
  const response = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === follow.clientMessageId);
  assert.ok(response?.type === 'session.prompt_result' && response.result.type === 'steer');
  assert.equal(h.engine.task(before.id).currentRoundId, before.currentRoundId);
  assert.equal(h.engine.task(before.id).rounds.length, 1);
});

test('stopped or finished turns reject steer without creating another round', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Start') });
  const task = await h.claim();
  await h.engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
  const follow = { ...prompt('continue'), delivery: 'steer' as const };
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: follow });
  assert.ok(h.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === follow.clientMessageId && e.result.type === 'failed'));
  assert.equal(h.engine.task(task.id).messages.length, task.messages.length);
  assert.equal(h.engine.task(task.id).rounds.length, 1);
});

test('completion racing a steer cannot silently start a new round', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Start') });
  const task = await h.claim();
  const save = h.engine.providerPrompt.bind(h.engine);
  h.engine.providerPrompt = async input => {
    await h.result('Finished before steer was saved');
    return save(input);
  };
  const follow = { ...prompt('additional instructions'), delivery: 'steer' as const };
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: follow });
  const response = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === follow.clientMessageId);
  assert.ok(response?.type === 'session.prompt_result' && response.result.type === 'failed');
  const current = h.engine.task(task.id);
  assert.equal(current.currentRoundId, task.currentRoundId);
  assert.equal(current.rounds.length, 1);
  assert.equal(current.userMessageSeq, task.userMessageSeq);
  assert.equal(current.status, 'completed');
});

test('a new message during permission wait expires the old card without granting approval', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Start') });
  const task = await h.claim();
  await h.engine.requestPermission({ taskId: task.id, connectionId: task.connectionId, roundId: task.currentRoundId, userMessageSeq: task.userMessageSeq, requestId: randomUUID(), title: 'Read file', description: 'Confirm exact scope', scope: { toolName: 'read_dot_file', action: 'read', targets: ['one.ts'] } });
  const follow = { ...prompt('Do not modify files; explain only'), delivery: 'steer' as const, clearPendingPermissions: true };
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: follow });
  const current = h.engine.task(task.id);
  assert.equal(current.permissions[0].status, 'expired');
  assert.equal(current.currentRoundId, task.currentRoundId);
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await h.wait(() => cards(h.events).some(e => label(e) === '你的回复已发送，等待 Dot 继续处理。'));
});
