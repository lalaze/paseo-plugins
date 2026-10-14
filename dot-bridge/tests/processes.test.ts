import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { ProcessManager } from '../server/processes';
import { createMcpServer } from '../server/mcp-server';
import { withDispatch } from '../shared/machine';
import { toolInputSchemas } from '../shared/mcp';
import type { CommandSpec } from '../shared/processes';
import { permissionDescription } from '../shared/permissions';

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-processes-')));
  const root = join(dir, 'workspace'), data = join(dir, 'data'); await mkdir(root); await mkdir(data);
  const store = await BridgeStore.open(data), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const task = await engine.createTask({ operationId: randomUUID(), workspaceId: 'ws', workspaceRoot: root, mode: 'text', title: 'Run tests', requirement: 'Run the local test service', acceptance: '', repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '' });
  await store.mutate(d => { d.tasks[0] = withDispatch(d.tasks[0], Date.now()); });
  const identity = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId };
  await engine.claimTask(identity);
  t.after(async () => { await engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const input = (script: string, overrides: Partial<CommandSpec> = {}) => ({ ...identity, operationId: randomUUID(), userMessageSeq: engine.task(task.id).userMessageSeq, command: process.execPath, args: ['-e', script], cwd: '', timeoutMs: 10_000, waitMs: 1000, ...overrides });
  const approve = async (command: ReturnType<typeof input>, decision: 'approved' | 'denied' = 'approved') => {
    const request = { ...identity, requestId: randomUUID(), userMessageSeq: engine.task(task.id).userMessageSeq, title: 'Run exact local command', description: 'Run test fixture as host user', scope: { toolName: 'run_dot_command', action: 'Execute test fixture', targets: [command.cwd || '/'], operation: { kind: 'command' as const, operationId: command.operationId, command: command.command, args: command.args, cwd: command.cwd, timeoutMs: command.timeoutMs } } };
    await engine.requestPermission(request);
    await engine.respondPermission({ taskId: task.id, requestId: request.requestId, decision });
    command.userMessageSeq = engine.task(task.id).userMessageSeq;
    return request;
  };
  return { dir, root, data, store, engine, task, identity, input, approve };
}

test('command execution requires exact approval; output, exit code and durable retry are real', async t => {
  const h = await fixture(t), command = h.input('console.log(process.cwd()); console.error("stderr"); process.exitCode = 7;');
  await assert.rejects(h.engine.runCommand(command), /permission-required/);
  const request = await h.approve(command);
  assert.match(permissionDescription(request), /不是文件系统或网络沙箱/);
  await assert.rejects(h.engine.runCommand({ ...command, args: ['-e', 'console.log("other")'] }), /permission-required/);
  await assert.rejects(h.engine.runCommand({ ...command, timeoutMs: 20_000 }), /permission-required/);
  await assert.rejects(h.engine.runCommand({ ...command, operationId: randomUUID() }), /permission-required/);
  const result = await h.engine.runCommand(command);
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 7);
  assert.match(result.output, new RegExp(h.root)); assert.match(result.output, /stderr/);
  assert.ok(h.engine.task(h.task.id).permissions[0].consumedAt);
  assert.deepEqual(await h.engine.runCommand(command), result);
  await assert.rejects(h.engine.runCommand({ ...command, cwd: 'other' }), /duplicate-mismatch/);
  const journal = JSON.parse(await readFile(join(h.data, 'processes', `${command.operationId}.json`), 'utf8'));
  assert.equal(journal.exitCode, 7);
});

test('root cwd aliases create permission cards and execute once in the bound workspace', async t => {
  const h = await fixture(t);
  for (const cwd of ['.', './', '/']) {
    const command = h.input('console.log(process.cwd())', { cwd });
    await h.approve(command);
    const permission = h.engine.task(h.task.id).permissions.at(-1)!;
    assert.deepEqual(permission.scope.targets, ['/']);
    assert.equal(permission.scope.operation?.kind, 'command');
    if (permission.scope.operation?.kind === 'command') assert.equal(permission.scope.operation.cwd, '');
    const result = await h.engine.runCommand(command);
    assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), h.root);
    // Equivalent root spellings cannot cause another launch or invalidate an exact approval.
    assert.equal((await h.engine.runCommand({ ...command, cwd: '' })).pid, result.pid);
  }
  await mkdir(join(h.root, 'app'));
  const rootCommand = h.input('console.log(process.cwd())', { cwd: '.' });
  await h.approve(rootCommand);
  await assert.rejects(h.engine.runCommand({ ...rootCommand, cwd: 'app' }), /permission-required/);
  const subdirectory = h.input('console.log(process.cwd())', { cwd: 'app' });
  await h.approve(subdirectory);
  assert.equal((await h.engine.runCommand(subdirectory)).output.trim(), join(h.root, 'app'));
});

test('concurrent retries execute once and do not inherit daemon secrets or an implicit shell', async t => {
  const h = await fixture(t);
  process.env.DOT_PROCESS_TEST_SECRET = 'should-not-be-forwarded'; t.after(() => { delete process.env.DOT_PROCESS_TEST_SECRET; });
  const command = h.input('require("node:fs").appendFileSync("count", "1"); console.log(process.env.DOT_PROCESS_TEST_SECRET || "no-secret"); console.log(process.argv[1]);');
  command.args.push('$(touch accidental-shell-file)'); await h.approve(command);
  await Promise.all([h.engine.runCommand(command), h.engine.runCommand(command)]);
  const result = h.engine.readProcess({ ...command, offset: 0 });
  assert.equal(await readFile(join(h.root, 'count'), 'utf8'), '1');
  assert.match(result.output, /no-secret/); assert.match(result.output, /\$\(touch accidental-shell-file\)/);
  await assert.rejects(readFile(join(h.root, 'accidental-shell-file')));
});

test('cwd traversal, symlinks and protected directories are refused before execution', async t => {
  const h = await fixture(t); await symlink(h.root, join(h.root, 'linked'));
  for (const cwd of ['../outside', h.root, '/tmp', '.git', './app', 'app/', 'linked']) {
    const command = h.input('console.log("unexpected")', { cwd });
    if (cwd === 'linked') { await h.approve(command); await assert.rejects(h.engine.runCommand(command), /ordinary workspace directory/); }
    else await assert.rejects(h.approve(command));
  }
  assert.equal(h.engine.listProcesses(h.identity).processes.length, 0);
});

test('stale message, wrong connection and remote tasks cannot start host processes', async t => {
  const h = await fixture(t), command = h.input('console.log("no")'); await h.approve(command);
  await assert.rejects(h.engine.runCommand({ ...command, connectionId: '0'.repeat(32) }), /connection-invalid/);
  await assert.rejects(h.engine.runCommand({ ...command, roundId: randomUUID() }), /round-stale/);
  const task = h.engine.task(h.task.id);
  await h.engine.addMessage({ id: task.id, revision: task.revision, operationId: randomUUID(), kind: 'requirement', body: 'Wait before running' });
  await assert.rejects(h.engine.runCommand(command), /revision-conflict/);
  await h.store.mutate(d => { d.tasks[0].workspaceRoot = null; });
  await assert.rejects(h.engine.runCommand(command), /local host workspace/);
});

test('timeout and task cancellation stop background processes; logs remain readable', async t => {
  const h = await fixture(t), timeout = h.input('setInterval(() => console.log("tick"), 20)', { timeoutMs: 100 });
  await h.approve(timeout); const timed = await h.engine.runCommand(timeout);
  assert.equal(timed.status, 'timed-out');
  const background = h.input('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)');
  await h.approve(background); const started = await h.engine.runCommand(background); assert.equal(started.status, 'running');
  const task = h.engine.task(h.task.id);
  await h.engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
  const stopped = h.engine.readProcess({ ...background, offset: 0 });
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.signal, 'SIGKILL'); assert.match(stopped.output, /ready/);
  assert.equal((await h.engine.runCommand(background)).pid, started.pid);
  assert.throws(() => h.engine.readProcess({ ...background, taskId: randomUUID(), offset: 0 }));
  await assert.rejects(h.engine.stopProcess({ ...background, roundId: randomUUID() }), /does not belong/);
});

test('explicit stop, local closure and plugin disposal clean up owned processes', async t => {
  const h = await fixture(t);
  for (const action of ['explicit', 'close', 'dispose'] as const) {
    const command = h.input('console.log("ready"); setInterval(() => {}, 1000)'); await h.approve(command);
    assert.equal((await h.engine.runCommand(command)).status, 'running');
    if (action === 'explicit') assert.equal((await h.engine.stopProcess(command)).status, 'stopped');
    if (action === 'close') {
      const task = h.engine.task(h.task.id);
      await h.engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
      const stopping = h.engine.task(task.id);
      await h.engine.closeLocal({ id: task.id, roundId: command.roundId, revision: stopping.revision, operationId: randomUUID() });
      assert.equal(h.engine.readProcess({ ...command, offset: 0 }).status, 'stopped');
      const closed = h.engine.task(task.id);
      await h.engine.retryRound({ id: task.id, revision: closed.revision, operationId: randomUUID() });
      const retried = h.engine.task(task.id); h.identity.roundId = retried.currentRoundId;
      await h.store.mutate(d => { d.tasks[0] = withDispatch(d.tasks[0], Date.now()); }); await h.engine.claimTask(h.identity);
    }
    if (action === 'dispose') { await h.engine.dispose(); assert.equal(h.engine.readProcess({ ...command, offset: 0 }).status, 'stopped'); }
  }
});

test('large logs are bounded and paginated, with honest truncation', async t => {
  const h = await fixture(t), command = h.input('process.stdout.write("x".repeat(300000)); console.log("END");'); await h.approve(command);
  const result = await h.engine.runCommand(command); assert.equal(result.status, 'exited'); assert.equal(result.truncated, true);
  assert.equal(result.output.length, 16 * 1024);
  let offset = result.nextOffset, output = result.output;
  while (offset < result.logEnd) { const page = h.engine.readProcess({ ...command, offset }); output += page.output; assert.ok(page.nextOffset > offset); offset = page.nextOffset; }
  assert.equal(output.length, 256 * 1024); assert.match(output, /END\n$/);
});

test('lost state write never spawns; restart marks uncertain intents without resuming', async t => {
  const h = await fixture(t), command = h.input('require("node:fs").writeFileSync("must-not-run", "bad")'); await h.approve(command);
  // Fail the state write after reservation, before the permission-consumption commit.
  const original = h.store.mutate.bind(h.store);
  h.store.mutate = async change => original(draft => { change(draft); throw new Error('simulated persistence failure'); });
  await assert.rejects(h.engine.runCommand(command), /simulated persistence failure/);
  h.store.mutate = original;
  assert.equal(h.engine.readProcess({ ...command, offset: 0 }).status, 'failed');
  await assert.rejects(readFile(join(h.root, 'must-not-run')));
  const manager = new ProcessManager(h.data); manager.init();
  const id = randomUUID(), spec = { command: process.execPath, args: command.args, cwd: '', timeoutMs: 1000 };
  manager.reserve({ ...h.identity, operationId: id }, h.root, spec);
  const restored = new ProcessManager(h.data); restored.init();
  const recovered = restored.read({ ...h.identity, operationId: id });
  assert.equal(recovered.status, 'interrupted'); assert.match(recovered.error, /unknown/);
  assert.throws(() => restored.start(id), /cannot be started/);
  await assert.rejects(readFile(join(h.root, 'must-not-run')));
});

test('MCP exposes the tools and runs a real service with verifiable port and cleanup', async t => {
  const h = await fixture(t);
  const server = createMcpServer({ engine: h.engine, host: '127.0.0.1', port: 0, getToken: () => h.engine.mcpToken() });
  const { endpoint } = await server.start(); t.after(() => server.stop());
  const rpc = async (method: string, params: unknown, token = h.engine.mcpToken()) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  const discovery = await rpc('tools/list', {});
  for (const name of ['run_dot_command', 'read_dot_process', 'stop_dot_process', 'list_dot_processes']) assert.ok(discovery.body.result.tools.some((tool: { name: string }) => tool.name === name));
  const info = await rpc('tools/call', { name: 'get_dot_task', arguments: { connectionId: h.identity.connectionId, taskId: h.task.id } });
  const taskInfo = JSON.parse(info.body.result.content[0].text); assert.equal(taskInfo.commandsAvailable, true); assert.match(taskInfo.processInstructions, /NOT a filesystem/);
  const command = h.input('const http = require("node:http"); const server = http.createServer((req,res) => res.end("verified")); server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));');
  await h.approve(command);
  const args = { name: 'run_dot_command', arguments: command };
  assert.equal((await rpc('tools/call', args, 'invalid')).status, 401);
  const reply = await rpc('tools/call', args), result = JSON.parse(reply.body.result.content[0].text);
  assert.equal(result.status, 'running'); const port = /PORT=(\d+)/.exec(result.output); assert.ok(port);
  const url = `http://127.0.0.1:${port[1]}`; assert.equal(await (await fetch(url)).text(), 'verified');
  const { userMessageSeq: _seq, waitMs: _wait, command: _command, args: _args, cwd: _cwd, timeoutMs: _timeout, ...identity } = command;
  const stop = await rpc('tools/call', { name: 'stop_dot_process', arguments: identity }); assert.equal(JSON.parse(stop.body.result.content[0].text).status, 'stopped');
  await assert.rejects(fetch(url));
});

test('schema limits prevent oversized arguments and unbounded waits', () => {
  const base = { connectionId: 'a'.repeat(32), taskId: randomUUID(), roundId: randomUUID(), operationId: randomUUID(), userMessageSeq: 1, command: 'node' };
  assert.equal(toolInputSchemas.run_dot_command.parse(base).timeoutMs, 120_000);
  for (const extra of [{ waitMs: 10001 }, { timeoutMs: 86_400_001 }, { args: Array(129).fill('x') }, { args: ['x\0y'] }]) assert.equal(toolInputSchemas.run_dot_command.safeParse({ ...base, ...extra }).success, false);
});

test('denied and platform-blocked command approvals cannot launch', async t => {
  for (const decision of ['approved', 'denied'] as const) {
    const h = await fixture(t), command = h.input('console.log("must not execute")');
    const request = await h.approve(command, decision);
    if (decision === 'approved') await h.engine.reportPermissionBlocked({ ...h.identity, requestId: request.requestId, reason: 'Platform refused this launch' });
    await assert.rejects(h.engine.runCommand(command), /permission-required/);
    assert.equal(h.engine.listProcesses(h.identity).processes.length, 0);
  }
});

test('service survives completion and can be stopped using its original round', async t => {
  const h = await fixture(t), command = h.input('console.log("ready"); setInterval(() => {}, 1000)'); await h.approve(command);
  assert.equal((await h.engine.runCommand(command)).status, 'running');
  const task = h.engine.task(h.task.id);
  await h.engine.processResult({ ...h.identity, kind: 'text', updateId: randomUUID(), baseSha: null, headSha: null, branch: null, summary: 'Service started', checks: [], prUrl: null, processedThroughSeq: task.userMessageSeq });
  assert.equal(h.engine.readProcess({ ...command, offset: 0 }).status, 'running');
  assert.equal((await h.engine.stopProcess(command)).status, 'stopped');
});

test('leader exit cleans descendants holding output pipes, preserving the leader exit code', async t => {
  const h = await fixture(t);
  const childScript = 'process.on("SIGTERM", () => {}); console.log("child-ready"); setInterval(() => {}, 1000)';
  const command = h.input(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {stdio: "inherit"}); setTimeout(() => process.exit(0), 1000);`);
  command.waitMs = 4000; await h.approve(command);
  const result = await h.engine.runCommand(command);
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0); assert.match(result.output, /child-ready/);
  assert.notEqual(result.signal, 'SIGKILL');
});

test('spawn failure and real engine restart retain outcomes without re-executing', async t => {
  const h = await fixture(t), command = h.input('console.log("unused")', { command: join(h.root, 'nonexistent-executable') }); await h.approve(command);
  const result = await h.engine.runCommand(command); assert.equal(result.status, 'failed'); assert.match(result.error, /ENOENT/);
  await h.engine.dispose(); await h.store.dispose();
  const store = await BridgeStore.open(h.data), engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  try { assert.deepEqual(await engine.runCommand(command), result); }
  finally { await engine.dispose(); await store.dispose(); }
});

test('replaying an old stop or local closure cannot terminate a new round service', async t => {
  const h = await fixture(t), initial = h.engine.task(h.task.id);
  const cancel = { id: initial.id, revision: initial.revision, operationId: randomUUID() };
  await h.engine.cancelRequest(cancel);
  const stopping = h.engine.task(initial.id);
  const close = { id: initial.id, roundId: initial.currentRoundId, revision: stopping.revision, operationId: randomUUID() };
  await h.engine.closeLocal(close);
  const closed = h.engine.task(initial.id);
  await h.engine.retryRound({ id: initial.id, revision: closed.revision, operationId: randomUUID() });
  h.identity.roundId = h.engine.task(initial.id).currentRoundId;
  await h.store.mutate(d => { d.tasks[0] = withDispatch(d.tasks[0], Date.now()); }); await h.engine.claimTask(h.identity);
  const command = h.input('console.log("new-round-ready"); setInterval(() => {}, 1000)'); await h.approve(command);
  assert.equal((await h.engine.runCommand(command)).status, 'running');
  await h.engine.cancelRequest(cancel); await h.engine.closeLocal(close);
  assert.equal(h.engine.readProcess({ ...command, offset: 0 }).status, 'running');
});
