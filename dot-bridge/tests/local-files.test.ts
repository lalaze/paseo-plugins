import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { applyLocalChanges, canonicalWorkspace, listSources, readSource, sourceHash } from '../server/local-files';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { withDispatch, createTask } from '../shared/machine';
import { taskCreate } from '../shared/rpc';
import { createMcpServer } from '../server/mcp-server';
import type { LocalChange } from '../shared/local-files';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-local-'));
  const root = join(dir, 'workspace'); await mkdir(root);
  const dataDir = join(dir, 'data'); await mkdir(dataDir);
  const base = { root: canonicalWorkspace(root), dataDir, taskId: randomUUID(), roundId: randomUUID(), userMessageSeq: 1, at: Date.now() };
  const apply = (changes: LocalChange[], operationId = randomUUID()) => applyLocalChanges({ ...base, changes, operationId });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root: base.root, dir, dataDir, apply, base };
}

test('local create/update/delete needs no Git, keeps unrelated edits and backs up original bytes', async t => {
  const h = await fixture(t);
  await writeFile(join(h.root, 'main.ts'), '\ufeffexport const value = 1;\r\n', { mode: 0o755 });
  await writeFile(join(h.root, 'old.ts'), 'old');
  await writeFile(join(h.root, 'user-draft.ts'), 'uncommitted user draft');
  const before = readSource(h.root, 'main.ts'); assert.equal(before.content, '\ufeffexport const value = 1;\r\n');
  const receipt = h.apply([
    { path: 'src/new.ts', expectedSha256: null, content: 'export const added = true;\n' },
    { path: 'main.ts', expectedSha256: before.sha256, content: '\ufeffexport const value = 2;\r\n' },
    { path: 'old.ts', expectedSha256: sourceHash('old'), content: null },
  ]);
  assert.equal(receipt.status, 'applied'); assert.equal(receipt.files.length, 3);
  assert.equal(await readFile(join(h.root, 'src/new.ts'), 'utf8'), 'export const added = true;\n');
  assert.equal((await stat(join(h.root, 'main.ts'))).mode & 0o777, 0o755);
  assert.equal(readSource(h.root, 'old.ts').sha256, null);
  assert.equal(await readFile(join(h.root, 'user-draft.ts'), 'utf8'), 'uncommitted user draft');
  const journal = JSON.parse(await readFile(join(h.dataDir, 'local-changes', `${receipt.operationId}.json`), 'utf8'));
  assert.equal(journal.before[1].content, before.content);
});

test('stale file preflight prevents every write, including creation earlier in the batch', async t => {
  const h = await fixture(t); await writeFile(join(h.root, 'edit.ts'), 'user edited this');
  const receipt = h.apply([{ path: 'new.ts', expectedSha256: null, content: 'new' }, { path: 'edit.ts', expectedSha256: sourceHash('old'), content: 'overwrite' }]);
  assert.equal(receipt.status, 'conflict'); assert.deepEqual(receipt.files, []);
  assert.equal(readSource(h.root, 'new.ts').content, null);
  assert.equal(readSource(h.root, 'edit.ts').content, 'user edited this');
  assert.equal(h.apply([{ path: 'edit.ts', expectedSha256: null, content: 'new' }]).status, 'conflict');
});

test('local access rejects escapes, credentials, symlinks, hardlinks, binary files and ambiguous paths', async t => {
  const h = await fixture(t); await writeFile(join(h.dir, 'outside'), 'private');
  await writeFile(join(h.root, 'file.ts'), 'source'); await mkdir(join(h.root, 'src'));
  await symlink(h.dir, join(h.root, 'escape')); await symlink(join(h.root, 'src'), join(h.root, 'inside'));
  await link(join(h.root, 'file.ts'), join(h.root, 'hard.ts'));
  await writeFile(join(h.root, 'binary'), Buffer.from([0xff, 0x00]));
  await writeFile(join(h.root, 'big'), Buffer.alloc(256 * 1024 + 1));
  execFileSync('mkfifo', [join(h.root, 'pipe')]);
  for (const path of ['../outside', '/absolute', 'a/../outside', 'a\\b', '.git/config', '.env', '.aws/config', 'escape/outside', 'inside/new.ts', 'hard.ts', 'binary', 'big', 'pipe']) {
    assert.throws(() => readSource(h.root, path), path);
    assert.throws(() => h.apply([{ path, expectedSha256: null, content: 'overwrite' }]), path);
  }
  assert.equal(await readFile(join(h.dir, 'outside'), 'utf8'), 'private');
  assert.throws(() => h.apply([{ path: 'A.ts', expectedSha256: null, content: 'a' }, { path: 'a.ts', expectedSha256: null, content: 'b' }]), /ambiguous/);
  assert.throws(() => h.apply([{ path: 'a', expectedSha256: null, content: 'a' }, { path: 'a/b', expectedSha256: null, content: 'b' }]), /overlapping/);
  assert.ok(!listSources(h.root).entries.some(entry => ['escape', 'inside'].includes(entry.path)));
});

test('durable operation replay does not overwrite subsequent user edits', async t => {
  const h = await fixture(t); const id = randomUUID();
  const changes = [{ path: 'new.ts', expectedSha256: null, content: 'first' }];
  const first = h.apply(changes, id); await writeFile(join(h.root, 'new.ts'), 'user later edit');
  assert.deepEqual(h.apply(changes, id), first);
  assert.equal(readSource(h.root, 'new.ts').content, 'user later edit');
  assert.throws(() => h.apply([{ ...changes[0]!, content: 'different' }], id), /different content/);
});

test('interrupted batches report the applied subset without resuming remaining writes', async t => {
  const h = await fixture(t); const id = randomUUID();
  const changes = [{ path: 'a.ts', expectedSha256: null, content: 'a' }, { path: 'b.ts', expectedSha256: null, content: 'b' }];
  h.apply(changes, id);
  const file = join(h.dataDir, 'local-changes', `${id}.json`); const journal = JSON.parse(await readFile(file, 'utf8'));
  journal.finished = false; journal.receipt.files = journal.receipt.files.slice(0, 1); journal.intent = 1;
  await writeFile(file, JSON.stringify(journal)); await rm(join(h.root, 'b.ts'));
  const recovered = h.apply(changes, id);
  assert.equal(recovered.status, 'partial'); assert.equal(recovered.files.length, 1);
  assert.match(recovered.conflicts[0]!, /Interrupted/); assert.equal(readSource(h.root, 'b.ts').content, null);
  assert.deepEqual(h.apply(changes, id), recovered);
});

async function engineFixture(t: TestContext) {
  const h = await fixture(t); const store = await BridgeStore.open(h.dataDir);
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const task = await engine.createTask({ operationId: randomUUID(), workspaceId: 'ws', workspaceRoot: h.root, mode: 'text', title: 'Code', requirement: 'Change local code', acceptance: '', repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '' });
  const identity = { taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId };
  const claim = async () => { await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); }); await engine.claimTask(identity); };
  t.after(async () => { engine.dispose(); await store.dispose(); });
  return { ...h, store, engine, task, identity, claim };
}

test('MCP reviews user edits independently of Dot write receipts, including staged and new files', async t => {
  const h = await engineFixture(t); await h.claim();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: h.root, encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'export const value = 1;\n');
  git('add', 'main.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline');
  await writeFile(join(h.root, 'main.ts'), 'export const value = 2;\n'); git('add', 'main.ts');
  await writeFile(join(h.root, 'main.ts'), 'export const value = 3;\n');
  await writeFile(join(h.root, 'new.ts'), 'export const added = true;\n');
  assert.deepEqual(h.engine.task(h.task.id).localChanges, []);
  const beforeStatus = git('status', '--porcelain=v1'); const beforeHead = git('rev-parse', 'HEAD');
  const server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${h.engine.mcpToken()}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return await response.json() as { error?: unknown; result?: { content: Array<{ text: string }>; tools?: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
  };
  const listed = await rpc('tools/list', {});
  assert.equal(listed.result?.tools?.find(tool => tool.name === 'read_dot_workspace_changes')?.annotations.readOnlyHint, true);
  const reply = await rpc('tools/call', { name: 'read_dot_workspace_changes', arguments: h.identity });
  assert.equal(reply.error, undefined);
  const changes = JSON.parse(reply.result!.content[0]!.text);
  assert.equal(changes.isGitRepository, true); assert.equal(changes.totalFiles, 2);
  const main = changes.files.find((file: { path: string }) => file.path === 'main.ts');
  assert.match(main.stagedDiff, /-export const value = 1;[\s\S]*\+export const value = 2;/);
  assert.match(main.unstagedDiff, /-export const value = 2;[\s\S]*\+export const value = 3;/);
  assert.match(changes.files.find((file: { path: string }) => file.path === 'new.ts').untrackedDiff, /\+export const added = true;/);
  assert.match(h.engine.activity.list(h.task.id).at(-1)!.detail, /main.ts/);
  const single = await rpc('tools/call', { name: 'read_dot_workspace_changes', arguments: { ...h.identity, snapshotId: changes.snapshotId, path: 'main.ts', diffKind: 'unstaged', diffOffset: 0 } });
  assert.equal(single.error, undefined); assert.equal(JSON.parse(single.result!.content[0]!.text).files[0].unstagedDiff, main.unstagedDiff);
  const stale = await rpc('tools/call', { name: 'read_dot_workspace_changes', arguments: { ...h.identity, snapshotId: '0'.repeat(64), path: 'main.ts', diffKind: 'unstaged' } });
  assert.ok(stale.error);
  const taskReply = await rpc('tools/call', { name: 'get_dot_task', arguments: { connectionId: h.identity.connectionId, taskId: h.task.id } });
  assert.match(JSON.parse(taskReply.result!.content[0]!.text).localFileInstructions, /read_dot_workspace_changes/);
  assert.equal(git('status', '--porcelain=v1'), beforeStatus); assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.deepEqual(h.engine.task(h.task.id).localChanges, []);
});

test('local tools enforce connection, active claim, current round, current user input and stop', async t => {
  const h = await engineFixture(t); const args = { ...h.identity, path: 'main.ts' };
  const review = { ...h.identity, offset: 0 };
  await assert.rejects(h.engine.readLocalWorkspaceChanges(review), /claim/i);
  assert.throws(() => h.engine.readLocalFile(args), /claim/i); await h.claim();
  await assert.rejects(h.engine.readLocalWorkspaceChanges({ ...review, connectionId: '0'.repeat(32) }));
  await assert.rejects(h.engine.readLocalWorkspaceChanges({ ...review, roundId: randomUUID() }));
  assert.throws(() => h.engine.readLocalFile({ ...args, connectionId: '0'.repeat(32) }));
  assert.throws(() => h.engine.readLocalFile({ ...args, roundId: randomUUID() }));
  assert.equal(h.engine.readLocalFile(args).sha256, null);
  const apply = { ...h.identity, operationId: randomUUID(), userMessageSeq: 1, changes: [{ path: 'main.ts', expectedSha256: null, content: 'new' }] };
  const current = h.engine.task(h.task.id);
  await h.engine.addMessage({ id: current.id, revision: current.revision, operationId: randomUUID(), body: 'Wait, revise the change', kind: 'requirement' });
  await assert.rejects(h.engine.applyLocalFiles(apply), /newer user message/i);
  const latest = h.engine.task(current.id);
  await h.engine.cancelRequest({ id: latest.id, revision: latest.revision, operationId: randomUUID() });
  assert.throws(() => h.engine.readLocalFile(args), /stop request/);
  await assert.rejects(h.engine.readLocalWorkspaceChanges(review), /stop request/);
  await assert.rejects(h.engine.applyLocalFiles({ ...apply, userMessageSeq: latest.userMessageSeq }), /stop request/);
  assert.equal(readSource(h.root, 'main.ts').content, null);
});

test('concurrent local requests deduplicate, persist visible receipts and replay after restart', async t => {
  const h = await engineFixture(t); await h.claim();
  const input = { ...h.identity, operationId: randomUUID(), userMessageSeq: 1, changes: [{ path: 'main.ts', expectedSha256: null, content: 'new' }] };
  const [a, b] = await Promise.all([h.engine.applyLocalFiles(input), h.engine.applyLocalFiles(input)]);
  assert.deepEqual(a, b); assert.equal(h.engine.task(h.task.id).localChanges.length, 1);
  assert.ok(h.engine.task(h.task.id).messages.some(message => message.body.includes('main.ts')));
  await writeFile(join(h.root, 'main.ts'), 'later user edit');
  h.engine.dispose(); await h.store.dispose();
  const store = await BridgeStore.open(h.dataDir); const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  try { assert.deepEqual(await engine.applyLocalFiles(input), a); assert.equal(readSource(h.root, 'main.ts').content, 'later user edit'); }
  finally { engine.dispose(); await store.dispose(); }
});

test('installed mode removes Git delivery while preserving old records as read-only history', async t => {
  const h = await engineFixture(t);
  assert.equal(taskCreate.input.safeParse({ operationId: randomUUID(), workspaceId: 'ws', title: 'old', requirement: 'old', mode: 'git', repository: 'url', remoteName: 'origin', baseSha: 'a'.repeat(40), targetBranch: 'main' }).success, false);
  const old = createTask({ id: randomUUID(), roundId: randomUUID(), connectionId: h.task.connectionId, workspaceId: 'ws', mode: 'git', title: 'Legacy', requirement: 'Legacy', acceptance: '', repository: 'https://github.com/a/b', remoteName: 'origin', branch: 'dot/legacy', baseSha: 'a'.repeat(40), targetBranch: 'main', environmentHint: '', at: Date.now() });
  await h.store.mutate(draft => { draft.tasks.push(withDispatch(old, Date.now())); });
  assert.equal(h.engine.getForConnection(old.connectionId, old.id).title, 'Legacy');
  assert.ok(!h.engine.listForConnection(old.connectionId, null).tasks.some(task => task.taskId === old.id));
  await assert.rejects(h.engine.claimTask({ connectionId: old.connectionId, taskId: old.id, roundId: old.currentRoundId }), /read-only/);
  await assert.rejects(h.engine.createRound({ id: old.id, revision: old.revision, operationId: randomUUID() }), /read-only/);
});

test('authenticated MCP reads current source and applies a change; retired Git tool is unavailable', async t => {
  const h = await engineFixture(t); await h.claim();
  await writeFile(join(h.root, 'main.ts'), 'export const n = 1;');
  const server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const call = async (name: string, args: unknown, authorized = true) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${h.engine.mcpToken()}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as { error?: unknown; result?: { content: Array<{text: string}> } };
    return { status: response.status, error: body.error, data: body.result ? JSON.parse(body.result.content[0]!.text) : null };
  };
  assert.equal((await call('read_dot_file', { ...h.identity, path: 'main.ts' }, false)).status, 401);
  const read = await call('read_dot_file', { ...h.identity, path: 'main.ts' });
  assert.equal(read.data.content, 'export const n = 1;');
  const apply = await call('apply_dot_changes', { ...h.identity, operationId: randomUUID(), userMessageSeq: read.data.userMessageSeq, changes: [{ path: 'main.ts', expectedSha256: read.data.sha256, content: 'export const n = 2;' }] });
  assert.equal(apply.error, undefined); assert.equal(apply.data.status, 'applied');
  assert.equal(await readFile(join(h.root, 'main.ts'), 'utf8'), 'export const n = 2;');
  assert.ok((await call('submit_dot_result', {})).error);
});

test('a lost payload rebuild needs fresh operation-bound approval and stale rebuilt writes conflict', async t => {
  const h = await engineFixture(t); await h.claim();
  await writeFile(join(h.root, 'lost.ts'), 'lost 1');
  const approve = async (operationId: string, expectedSha256: string, content: string) => {
    const requestId = randomUUID();
    await h.engine.requestPermission({ ...h.identity, requestId, userMessageSeq: h.engine.task(h.task.id).userMessageSeq,
      title: 'Rebuild requested edit', description: 'Exact rebuilt payload', scope: { toolName: 'apply_dot_changes', action: 'Edit', targets: ['lost.ts'],
        operation: { kind: 'files', operationId, changes: [{ path: 'lost.ts', expectedSha256, contentSha256: sourceHash(content) }] } } });
    await h.engine.respondPermission({ taskId: h.task.id, requestId, decision: 'approved' });
    return { ...h.identity, operationId, userMessageSeq: h.engine.task(h.task.id).userMessageSeq, changes: [{ path: 'lost.ts', expectedSha256, content }] };
  };
  const original = await approve(randomUUID(), sourceHash('lost 1'), 'lost 2');
  const rebuiltId = randomUUID();
  await assert.rejects(h.engine.applyLocalFiles({ ...original, operationId: rebuiltId }), /permission-required/);
  const rebuilt = await approve(rebuiltId, sourceHash('lost 1'), 'lost 2');
  assert.equal((await h.engine.applyLocalFiles(rebuilt)).status, 'applied');
  const stale = await approve(randomUUID(), sourceHash('lost 2'), 'lost 4');
  await writeFile(join(h.root, 'lost.ts'), 'lost 3');
  assert.equal((await h.engine.applyLocalFiles(stale)).status, 'conflict');
  assert.equal(readSource(h.root, 'lost.ts').content, 'lost 3');
});

test('a failed state save after file application recovers from the durable journal without overwriting', async t => {
  const h = await fixture(t); let rejectWrite = false;
  const store = await BridgeStore.open(h.dataDir, { write: async body => { if (rejectWrite) { rejectWrite = false; throw new Error('simulated state write failure'); } await writeFile(join(h.dataDir, 'state.json'), body); } });
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  t.after(async () => {engine.dispose(); await store.dispose();});
  const {task} = await engine.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws', cwd: h.root, body: 'Edit', systemPrompt: '', attachments: [] });
  await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
  const identity = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId };
  await engine.claimTask(identity);
  const input = { ...identity, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'main.ts', expectedSha256: null, content: 'first' }] };
  rejectWrite = true; await assert.rejects(engine.applyLocalFiles(input), /state write failure/);
  assert.equal(readSource(h.root, 'main.ts').content, 'first');
  await writeFile(join(h.root, 'main.ts'), 'later edit');
  assert.equal((await engine.applyLocalFiles(input)).status, 'applied');
  assert.equal(engine.task(task.id).localChanges.length, 1);
  assert.equal(readSource(h.root, 'main.ts').content, 'later edit');
});


test('scoped workspace review never opens a file outside the exact read grant', async t => {
  const h = await engineFixture(t); await h.claim();
  execFileSync('git', ['init', '-q'], { cwd: h.root });
  for (const path of ['allowed.ts', 'private.ts']) await writeFile(join(h.root, path), path + '\n');
  const request = { ...h.identity, requestId: randomUUID(), userMessageSeq: 1, title: 'Read', description: 'Read one file', scope: { toolName: 'read_dot_file', action: 'Read', targets: ['allowed.ts'] } };
  await h.engine.requestPermission(request);
  await h.engine.respondPermission({ taskId: h.task.id, requestId: request.requestId, decision: 'approved' });
  const original = fs.openSync; let privateReads = 0;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === join(h.root, 'private.ts')) privateReads++;
    return original(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const first = await h.engine.readLocalWorkspaceChanges({ ...h.identity, offset: 0 });
    assert.deepEqual(first.files.map(file => file.path), ['allowed.ts']);
    assert.equal(first.scopeLimited, true);
    const next = await h.engine.readLocalWorkspaceChanges({ ...h.identity, offset: 0, snapshotId: first.snapshotId, path: 'allowed.ts' });
    assert.deepEqual(next.files.map(file => file.path), ['allowed.ts']);
    await assert.rejects(h.engine.readLocalWorkspaceChanges({ ...h.identity, offset: 0, snapshotId: first.snapshotId, path: 'private.ts' }), /permission/);
    assert.equal(privateReads, 0);
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
});
