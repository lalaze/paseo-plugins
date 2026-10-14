import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { createMcpServer } from '../server/mcp-server';
import { receiveChunk, saveDeliveredFile } from '../server/attachment-transfers';
import { ATTACHMENT_CHUNK_BYTES, MAX_FILE_BYTES } from '../shared/attachments';
import { withDispatch } from '../shared/machine';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-transfer-'));
  let store = await BridgeStore.open(dir);
  let engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const task = await engine.createTask({ operationId: randomUUID(), workspaceId: 'ws', mode: 'text', title: 'Files', requirement: 'Return files', acceptance: '', repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '' });
  const identity = { taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId };
  await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
  await engine.claimTask(identity);
  t.after(async () => { engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get engine() { return engine; }, get store() { return store; }, identity,
    async restart() { engine.dispose(); await store.dispose(); store = await BridgeStore.open(dir); engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init(); },
  };
}

function chunks(identity: { taskId: string; roundId: string; connectionId: string }, bytes: Buffer, operationId = randomUUID()) {
  return Array.from({ length: Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES) }, (_, index) => ({ ...identity, operationId, name: 'test.bin', mediaType: 'application/octet-stream', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), index, content: bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES).toString('base64') }));
}

test('Dot can deliver more than 16 files through both upload paths without losing old bytes', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 17; i++) await h.engine.uploadAttachment({ ...h.identity, id: h.identity.taskId,
    operationId: randomUUID(), actor: 'dot', name: `note-${i}.txt`, mediaType: 'text/plain', encoding: 'utf8', content: `note ${i}` });
  const parts = chunks(h.identity, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7, 42));
  for (const part of parts) await h.engine.uploadAttachmentChunk(part);
  assert.equal(h.engine.task(h.identity.taskId).attachments.length, 18);
  await h.restart();
  const files = h.engine.task(h.identity.taskId).attachments;
  assert.equal(files.length, 18);
  assert.equal((await h.engine.readAttachment(h.identity.taskId, files[0]!.id)).content, 'note 0');
  assert.deepEqual(await readFile(files.at(-1)!.localPath!), Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7, 42));
  assert.equal((await h.engine.uploadAttachmentChunk(parts[0]!)).complete, true);
  assert.equal(h.engine.task(h.identity.taskId).attachments.length, 18);
});

test('2 MiB transfer resumes out of order across restart, saves a named file, and reads exact chunks over authenticated MCP', async t => {
  const h = await fixture(t); const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const parts = chunks(h.identity, bytes);
  assert.equal((await h.engine.uploadAttachmentChunk(parts[1]!)).complete, false);
  assert.deepEqual((await h.engine.uploadAttachmentChunk(parts[1]!)).received, [1]);
  assert.equal(h.engine.task(h.identity.taskId).attachments.length, 0);
  await h.restart();
  const server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const call = async (name: string, args: unknown, authorized = true) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${h.engine.mcpToken()}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as { error?: unknown; result?: { content: Array<{text: string}> } };
    return { status: response.status, error: body.error, data: body.result ? JSON.parse(body.result.content[0]!.text) : null };
  };
  assert.equal((await call('upload_dot_attachment_chunk', parts[0], false)).status, 401);
  for (const part of parts) assert.equal((await call('upload_dot_attachment_chunk', part)).error, undefined);
  const attachment = h.engine.task(h.identity.taskId).attachments[0]!;
  assert.ok(attachment.localPath); assert.deepEqual(await readFile(attachment.localPath), bytes);
  assert.equal((await stat(attachment.localPath)).mode & 0o777, 0o600);
  const read: Buffer[] = [];
  for (let index = 0; index < parts.length; index++) {
    const result = await call('read_dot_attachment_chunk', { connectionId: h.identity.connectionId, taskId: h.identity.taskId, attachmentId: attachment.id, index });
    assert.equal(result.error, undefined); assert.equal(result.data.done, index === parts.length - 1);
    read.push(Buffer.from(result.data.content, 'base64'));
  }
  assert.deepEqual(Buffer.concat(read), bytes);
  await assert.rejects(h.engine.readAttachment(h.identity.taskId, attachment.id), /read_dot_attachment_chunk/);
  await writeFile(attachment.localPath, 'user edit');
  await h.restart();
  assert.equal((await h.engine.uploadAttachmentChunk(parts[0]!)).complete, true);
  assert.equal(await readFile(attachment.localPath, 'utf8'), 'user edit');
  assert.equal(h.engine.task(h.identity.taskId).attachments.length, 1);
});

test('chunk transfer rejects changed bytes, manifests, size limits and whole-file corruption', async t => {
  const h = await fixture(t); const parts = chunks(h.identity, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7, 42));
  await h.engine.uploadAttachmentChunk(parts[0]!);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[0]!, name: 'changed.bin' }), /duplicate/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[0]!, content: Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 41).toString('base64') }), /duplicate/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[1]!, content: 'YQ==' }), /chunk/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[0]!, size: MAX_FILE_BYTES + 1 }));
  const corrupt = parts.map(part => ({ ...part, operationId: randomUUID(), sha256: '0'.repeat(64) }));
  corrupt[1]!.operationId = corrupt[0]!.operationId;
  await h.engine.uploadAttachmentChunk(corrupt[0]!);
  await assert.rejects(h.engine.uploadAttachmentChunk(corrupt[1]!), /whole-file hash/);
  assert.equal(h.engine.task(h.identity.taskId).attachments.length, 0);
});

test('chunk approval binds the manifest, survives restart and is consumed only after final publication', async t => {
  const h = await fixture(t);
  const parts = chunks(h.identity, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7, 42));
  const first = parts[0]!;
  const request = { ...h.identity, requestId: randomUUID(), userMessageSeq: h.engine.task(h.identity.taskId).userMessageSeq, title: 'Upload test.bin', description: 'Deliver synthetic bytes once', scope: { toolName: 'upload_dot_attachment_chunk', action: 'Upload', targets: [first.name], operation: { kind: 'attachment' as const, operationId: first.operationId, name: first.name, mediaType: first.mediaType, size: first.size, sha256: first.sha256 } } };
  await h.engine.requestPermission(request);
  await assert.rejects(h.engine.uploadAttachmentChunk(first), /permission-required/);
  await h.engine.respondPermission({ taskId: h.identity.taskId, requestId: request.requestId, decision: 'approved' });
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...first, sha256: '0'.repeat(64) }), /permission-required/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...first, operationId: randomUUID() }), /permission-required/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...first, mediaType: 'text/plain' }), /permission-required/);
  assert.equal((await h.engine.uploadAttachmentChunk(first)).complete, false);
  assert.equal(h.engine.task(h.identity.taskId).permissions[0].consumedAt, null);
  await h.restart();
  const complete = await h.engine.uploadAttachmentChunk(parts[1]!);
  assert.equal(complete.complete, true);
  assert.notEqual(h.engine.task(h.identity.taskId).permissions[0].consumedAt, null);
  await h.restart();
  assert.deepEqual(await h.engine.uploadAttachmentChunk(first), complete);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...first, operationId: randomUUID() }), /permission-required/);
});

test('connection, round, claim and stop protect chunk writes, including the final chunk', async t => {
  const h = await fixture(t); const parts = chunks(h.identity, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 7));
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[0]!, connectionId: '0'.repeat(32) }), /connection/);
  await assert.rejects(h.engine.uploadAttachmentChunk({ ...parts[0]!, roundId: randomUUID() }), /round/);
  await h.engine.uploadAttachmentChunk(parts[0]!);
  const task = h.engine.task(h.identity.taskId);
  await h.engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
  await assert.rejects(h.engine.uploadAttachmentChunk(parts[1]!), /stop/);
  await assert.rejects(h.engine.uploadAttachment({ ...h.identity, id: task.id, operationId: randomUUID(), actor: 'dot', name: 'stop.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'stop' }), /stop/);
  assert.equal(h.engine.task(task.id).attachments.length, 0);
});

test('automatic saves are unique per operation, refuse traversal/symlinks/edited destinations, and inline uploads also save', async t => {
  const h = await fixture(t);
  const input = { ...h.identity, id: h.identity.taskId, operationId: randomUUID(), actor: 'dot' as const, name: 'result.txt', mediaType: 'text/plain', encoding: 'utf8' as const, content: 'hello' };
  const { attachment } = await h.engine.uploadAttachment(input);
  assert.equal(await readFile(attachment.localPath!, 'utf8'), 'hello');
  const another = await h.engine.uploadAttachment({ ...input, operationId: randomUUID(), content: 'second' });
  assert.notEqual(another.attachment.localPath, attachment.localPath);
  assert.equal(await readFile(attachment.localPath!, 'utf8'), 'hello');
  const save = (name: string) => saveDeliveredFile(h.dir, h.identity.taskId, input.operationId, name, Buffer.from('changed'));
  assert.throws(() => save('../escape'));
  assert.throws(() => save('result.txt'), /refusing to overwrite/);
  await symlink(attachment.localPath!, join(h.dir, 'files', h.identity.taskId, input.operationId, 'link.txt'));
  assert.throws(() => save('link.txt'), /unsafe/);
});

test('incomplete transfer count is bounded, and completed transfers at the 20 MiB limit preserve bytes', async t => {
  const h = await fixture(t); const parts = chunks(h.identity, Buffer.alloc(MAX_FILE_BYTES, 37));
  let result;
  for (const part of parts) result = receiveChunk(h.dir, part, Date.now());
  assert.deepEqual(result!.bytes, Buffer.alloc(MAX_FILE_BYTES, 37));
  for (let i = 0; i < 15; i++) receiveChunk(h.dir, { ...parts[0]!, operationId: randomUUID() }, Date.now());
  assert.throws(() => receiveChunk(h.dir, { ...parts[0]!, operationId: randomUUID() }, Date.now()), /transfer-limit/);
});
