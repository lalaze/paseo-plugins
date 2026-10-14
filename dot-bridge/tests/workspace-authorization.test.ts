import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { WorkspaceAuthorizationStore, findWorkspaceGrant } from '../server/workspace-authorization';
import { sourceHash } from '../server/local-files';
import { withDispatch } from '../shared/machine';
import { workspaceAuthorizationSet } from '../shared/workspace-authorization';
import { withPromptAuthorization } from '../shared/prompt-authorization';
import { createMcpServer } from '../server/mcp-server';

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-auto-auth-')));
  const root = join(dir, 'workspace'), data = join(dir, 'data'); await mkdir(root); await mkdir(data);
  const store = await BridgeStore.open(data), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const task = await engine.createTask({ operationId: randomUUID(), workspaceId: 'ws', workspaceRoot: root, mode: 'text', title: 'Task', requirement: 'Update requested source and test it', acceptance: '', repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '' });
  await store.mutate(d => { d.tasks[0] = withDispatch(d.tasks[0], Date.now()); });
  const identity = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId }; await engine.claimTask(identity);
  t.after(async () => { await engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const toggle = (enabled: boolean) => engine.configureWorkspaceAuthorization('ws', root, enabled, engine.workspaceAuthorizationStatus('ws', root).revision);
  const command = (script = 'console.log("actual-result")') => ({ ...identity, operationId: randomUUID(), userMessageSeq: engine.task(task.id).userMessageSeq, command: process.execPath, args: ['-e', script], cwd: '', timeoutMs: 10_000, waitMs: 1000 });
  const request = (cmd = command()) => ({ ...identity, requestId: randomUUID(), userMessageSeq: engine.task(task.id).userMessageSeq, title: 'Run tests', description: 'Run exact fixture as host user', scope: { toolName: 'run_dot_command', action: 'Test fixture', targets: ['/'], operation: { kind: 'command' as const, operationId: cmd.operationId, command: cmd.command, args: cmd.args, cwd: cmd.cwd, timeoutMs: cmd.timeoutMs } } });
  return { dir, root, data, store, engine, task, identity, toggle, command, request };
}

test('default off; opt-in runs a real command without a card and retries execute only once', async t => {
  const h = await fixture(t), cmd = h.command('require("node:fs").appendFileSync("count", "1"); console.log("actual-result")');
  assert.equal(h.engine.automaticAuthorization(h.task).enabled, false);
  await assert.rejects(h.engine.runCommand(cmd), /permission-required/);
  await h.toggle(true);
  const results = await Promise.all([h.engine.runCommand(cmd), h.engine.runCommand(cmd)]);
  assert.equal(results[0].exitCode, 0); assert.match(results[0].output, /actual-result/);
  assert.equal(await readFile(join(h.root, 'count'), 'utf8'), '1');
  assert.equal(h.engine.task(h.task.id).permissions.length, 0);
  assert.equal(h.engine.task(h.task.id).userMessageSeq, h.task.userMessageSeq);
});

test('compatibility permission requests become policy records, never fabricated user decisions; revocation invalidates them', async t => {
  const h = await fixture(t); await h.toggle(true);
  const cmd = h.command(), request = h.request(cmd), before = h.engine.task(h.task.id);
  const result = await h.engine.requestPermission(request);
  assert.equal(result.status, 'approved'); assert.ok(result.workspaceGrantId);
  const next = h.engine.task(h.task.id);
  assert.equal(next.userMessageSeq, before.userMessageSeq); assert.equal(next.status, before.status);
  assert.match(next.messages.at(-1)!.body, /不代表用户点击允许/);
  assert.deepEqual(await h.engine.requestPermission(request), result);
  await h.toggle(false);
  assert.equal(h.engine.task(h.task.id).permissions[0].status, 'expired');
  await assert.rejects(h.engine.requestPermission(request), /permission-stale/);
  await assert.rejects(h.engine.runCommand(cmd), /permission-required/);
});

test('files and attachments continue after a consumed manual approval, retaining protected paths, hashes and stop checks', async t => {
  const h = await fixture(t), cmd = h.command(), req = h.request(cmd);
  await h.engine.requestPermission(req); await h.engine.respondPermission({ taskId: h.task.id, requestId: req.requestId, decision: 'approved' });
  cmd.userMessageSeq = h.engine.task(h.task.id).userMessageSeq; await h.engine.runCommand(cmd);
  const write = () => ({ ...h.identity, operationId: randomUUID(), userMessageSeq: h.engine.task(h.task.id).userMessageSeq, changes: [{ path: 'source.ts', expectedSha256: null, content: 'export const n = 1;' }] });
  await assert.rejects(h.engine.applyLocalFiles(write()), /permission-required/);
  await h.toggle(true);
  assert.equal((await h.engine.applyLocalFiles(write())).status, 'applied');
  assert.equal(h.engine.readLocalFile({ ...h.identity, path: 'source.ts' }).sha256, sourceHash('export const n = 1;'));
  assert.equal((await h.engine.applyLocalFiles(write())).status, 'conflict');
  await assert.rejects(h.engine.applyLocalFiles({ ...write(), changes: [{ path: '.env', expectedSha256: null, content: 'secret' }] }));
  const uploaded = await h.engine.uploadAttachment({ id: h.task.id, ...h.identity, operationId: randomUUID(), actor: 'dot', name: 'report.txt', mediaType: 'text/plain', encoding: 'utf8', content: 'test output' });
  assert.equal(uploaded.attachment.name, 'report.txt');
  const current = h.engine.task(h.task.id);
  await h.engine.addMessage({ id: current.id, revision: current.revision, operationId: randomUUID(), kind: 'answer', body: 'Continue only with requested changes' });
  await assert.rejects(h.engine.applyLocalFiles({ ...write(), userMessageSeq: current.userMessageSeq }), /revision-conflict/);
  const fresh = h.engine.task(h.task.id);
  await h.engine.cancelRequest({ id: fresh.id, revision: fresh.revision, operationId: randomUUID() });
  await assert.rejects(h.engine.runCommand(h.command()), /claim-required/);
});

test('enable does not approve pending or denied requests; a new explicit request stays manual after refusal', async t => {
  const h = await fixture(t), cmd = h.command(), req = h.request(cmd);
  await h.engine.requestPermission(req); await h.toggle(true);
  await assert.rejects(h.engine.runCommand(cmd), /permission-required/);
  assert.equal((await h.engine.requestPermission(req)).status, 'pending');
  await h.engine.respondPermission({ taskId: h.task.id, requestId: req.requestId, decision: 'denied' });
  await assert.rejects(h.engine.runCommand(h.command()), /permission-required/);
  const current = h.engine.task(h.task.id);
  await h.engine.addMessage({ id: current.id, revision: current.revision, operationId: randomUUID(), kind: 'answer', body: 'Please submit a fresh exact request for my review' });
  await assert.rejects(h.engine.runCommand(h.command()), /permission-required/);
  const fresh = await h.engine.requestPermission(h.request());
  assert.equal(fresh.status, 'pending'); assert.equal(fresh.workspaceGrantId, undefined);
});

test('platform blocks stay enforced after enable and after new messages', async t => {
  const h = await fixture(t); await h.toggle(true);
  const req = h.request(); await h.engine.requestPermission(req);
  await h.engine.reportPermissionBlocked({ ...h.identity, requestId: req.requestId, reason: 'Actual platform refusal' });
  await assert.rejects(h.engine.runCommand(h.command()), /permission-required/);
  const current = h.engine.task(h.task.id);
  await h.engine.addMessage({ id: current.id, revision: current.revision, operationId: randomUUID(), kind: 'answer', body: 'Explain the remaining restriction' });
  await assert.rejects(h.engine.runCommand(h.command()), /permission-required/);
});

test('a current manual scoped read cannot be widened by automatic reads or review requests', async t => {
  const h = await fixture(t); await writeFile(join(h.root, 'one.ts'), 'one'); await writeFile(join(h.root, 'two.ts'), 'two');
  const req = { ...h.request(), scope: { toolName: 'read_dot_file', action: 'Read one source', targets: ['one.ts'] } };
  await h.engine.requestPermission(req); await h.engine.respondPermission({ taskId: h.task.id, requestId: req.requestId, decision: 'approved' });
  await h.toggle(true);
  assert.equal(h.engine.readLocalFile({ ...h.identity, path: 'one.ts' }).content, 'one');
  assert.throws(() => h.engine.readLocalFile({ ...h.identity, path: 'two.ts' }), /permission-required/);
  const diffReq = { ...h.request(), scope: { toolName: 'read_dot_workspace_changes', action: 'Review all', targets: ['/'] } };
  assert.equal((await h.engine.requestPermission(diffReq)).status, 'pending');
});

test('revocation between persistence and spawn fails the reservation without launching', async t => {
  const h = await fixture(t); await h.toggle(true);
  const original = h.store.mutate.bind(h.store);
  h.store.mutate = async change => {
    const result = await original(change);
    h.store.mutate = original;
    await h.toggle(false);
    return result;
  };
  const result = await h.engine.runCommand(h.command('require("node:fs").writeFileSync("must-not-run", "bad")'));
  assert.equal(result.status, 'failed'); assert.match(result.error, /revoked/);
  await assert.rejects(readFile(join(h.root, 'must-not-run')));
});

test('grant survives real engine restart and is bound to exact ID, path and directory identity', async t => {
  const h = await fixture(t); await h.toggle(true);
  await h.engine.dispose(); await h.store.dispose();
  const store = await BridgeStore.open(h.data), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  try {
    assert.equal(engine.automaticAuthorization(engine.task(h.task.id)).enabled, true);
    const cmd = h.command(); assert.equal((await engine.runCommand(cmd)).exitCode, 0);
    assert.equal(engine.automaticAuthorization({ ...h.task, workspaceId: 'other' }).enabled, false);
    assert.equal(engine.automaticAuthorization({ ...h.task, workspaceRoot: h.data }).enabled, false);
    await rename(h.root, join(h.dir, 'previous-workspace')); await mkdir(h.root);
    assert.equal(engine.automaticAuthorization(engine.task(h.task.id)).enabled, false);
    await assert.rejects(engine.runCommand(h.command()), /permission-required/);
  } finally { await engine.dispose(); await store.dispose(); }
});

test('host policy is private, revision checked and fails closed on bad state or symlink roots', async t => {
  const h = await fixture(t), status = h.engine.workspaceAuthorizationStatus('ws', h.root);
  const policy = new WorkspaceAuthorizationStore(h.data); policy.init(); policy.set('ws', h.root, true, status.revision);
  assert.throws(() => policy.set('ws', h.root, false, status.revision), /revision-conflict/);
  assert.equal((await stat(join(h.data, 'workspace-authorizations.json'))).mode & 0o777, 0o600);
  assert.equal(findWorkspaceGrant(policy.grants(), 'ws', h.data), undefined);
  const link = join(h.dir, 'alias'); await symlink(h.root, link);
  assert.throws(() => policy.set('other', link, true, '1'));
  assert.equal(workspaceAuthorizationSet.input.safeParse({ workspaceId: 'ws', workspaceRoot: h.root, rootIdentity: status.rootIdentity, enabled: true, revision: '1', confirm: false }).success, false);
  await writeFile(join(h.data, 'workspace-authorizations.json'), '{"version":1,"revision":2,"grants":[{"workspaceId":"ws"}]}');
  assert.throws(() => new WorkspaceAuthorizationStore(h.data).init());
});

test('get_dot_task reports live policy; MCP cannot enable it and remote tasks never inherit it', async t => {
  const h = await fixture(t), server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const address = await server.start(); t.after(() => server.stop());
  const rpc = async (method: string, params: unknown) => (await (await fetch(address.endpoint, { method: 'POST', headers: { authorization: `Bearer ${h.engine.mcpToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })).json());
  const tools = await rpc('tools/list', {}) as { result: { tools: { name: string }[] } };
  assert.ok(!tools.result.tools.some(tool => /workspace.authorization/.test(tool.name)));
  await h.toggle(true);
  const result = await rpc('tools/call', { name: 'get_dot_task', arguments: { connectionId: h.identity.connectionId, taskId: h.task.id } }) as { result: { content: { text: string }[] } };
  const info = JSON.parse(result.result.content[0].text);
  assert.equal(info.workspaceAutomaticAuthorization.enabled, true);
  assert.match(info.permissionInstructions, /not a user clicking Allow/);
  const executed = await rpc('tools/call', { name: 'run_dot_command', arguments: h.command() }) as { result: { content: { text: string }[] } };
  assert.equal(JSON.parse(executed.result.content[0].text).exitCode, 0);
  await h.store.mutate(d => { d.tasks[0].remoteOrigin = { deviceId: randomUUID(), workspaceId: 'ws' }; d.tasks[0].workspaceRoot = null; });
  assert.equal(h.engine.automaticAuthorization(h.engine.task(h.task.id)).enabled, false);
  await assert.rejects(h.engine.runCommand(h.command()), /local host workspace/);
});

test('workspace policy does not grant external tools and disabling leaves owned services available for cleanup', async t => {
  const h = await fixture(t); await h.toggle(true);
  const external = await h.engine.requestPermission({ ...h.request(), scope: { toolName: 'publish_external_site', action: 'Publish externally', targets: ['site'] } });
  assert.equal(external.status, 'pending'); assert.equal(external.workspaceGrantId, undefined);
  await h.engine.respondPermission({ taskId: h.task.id, requestId: external.requestId, decision: 'approved' });
  const cmd = h.command('console.log("ready"); setInterval(() => {}, 1000)');
  assert.equal((await h.engine.runCommand(cmd)).status, 'running');
  await h.toggle(false);
  assert.equal(h.engine.readProcess({ ...cmd, offset: 0 }).status, 'running');
  await assert.rejects(h.engine.runCommand(h.command()), /permission-required/);
  assert.equal((await h.engine.stopProcess(cmd)).status, 'stopped');
});

test('new prompts get an automatic authorization note without the old file-only setting', async t => {
  const h = await fixture(t); await h.toggle(true);
  const current = h.engine.task(h.task.id);
  const next = await h.engine.addMessage({ id: current.id, revision: current.revision, operationId: randomUUID(), kind: 'answer', body: 'Only explain this code' });
  assert.ok(next.messages.at(-1)!.body.startsWith('Only explain this code\n\n'));
  assert.match(next.messages.at(-1)!.body, /无需逐次 Paseo 权限卡/);
  assert.equal(current.messages[0].body, h.task.messages[0].body);
  assert.throws(() => withPromptAuthorization('x'.repeat(20_000), h.root, false, true), /超过消息长度/);
});
