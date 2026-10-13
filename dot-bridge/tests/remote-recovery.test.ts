import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createTask } from '../shared/machine';
import { canonicalJson } from '../shared/mcp';
import { remoteConfigSchema } from '../shared/remote';
import { taskSchema } from '../shared/schema';
import { RemoteClient } from '../server/remote-client';
import { RemoteRuntime } from '../server/remote-runtime';
import { RemoteCenter } from '../server/remote-center';
import { RemoteStateStore, type FileJob } from '../server/remote-state';
import { canonicalWorkspace, readSource } from '../server/local-files';
import type { BridgeEngine } from '../server/engine';

type ClientHarness = {
  call(action: string, input: unknown): Promise<unknown>;
  execute(job: FileJob): Promise<void>;
  reconcileLeases(): Promise<void>;
  flushResults(): Promise<void>;
  closed: boolean;
  validateJob(job: FileJob, task: ReturnType<typeof taskSchema.parse>): { cwd: string };
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace'); await mkdir(path);
  const root = canonicalWorkspace(path), state = new RemoteStateStore(join(dir, 'state')); await state.load();
  const task = taskSchema.parse(createTask({ id: randomUUID(), roundId: randomUUID(), connectionId: 'a'.repeat(32), workspaceId: 'ws', mode: 'text', title: 'Edit', requirement: 'Edit', acceptance: '', repository: null, remoteName: null, branch: null, baseSha: null, targetBranch: null, environmentHint: '', at: 1 }));
  task.remoteOrigin = { deviceId: randomUUID(), workspaceId: 'ws' }; task.workspaceRoot = null;
  task.provider = { cwd: root, clientMessageIds: {} }; task.status = 'running';
  task.rounds[0]!.remoteStatus = 'running'; task.rounds[0]!.claim = { taskId: task.id, claimedAt: 2 };
  const input = { taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, operationId: randomUUID(), userMessageSeq: task.userMessageSeq, changes: [{ path: 'new.ts', expectedSha256: null, content: 'must not be written by stale work' }] };
  const job: FileJob = { id: randomUUID(), taskId: task.id, roundId: task.currentRoundId, deviceId: task.remoteOrigin.deviceId, kind: 'apply', input, userMessageSeq: task.userMessageSeq, expiresAt: Date.now() + 60000, status: 'leased', error: null, hash: createHash('sha256').update(canonicalJson({ kind: 'apply', input })).digest('hex') };
  await state.mutate(draft => {
    draft.config = remoteConfigSchema.parse({ mode: 'remote', url: 'https://center.invalid', workspaceIds: ['ws'], readFiles: true, writeFiles: true });
    draft.token = 'fixture-only'; draft.cache = [task]; draft.bindings = [{ taskId: task.id, workspaceId: 'ws', cwd: root }];
  });
  const client = new RemoteClient(state, dir);
  t.after(() => client.close());
  return { dir, root, state, task, job, client, harness: client as unknown as ClientHarness };
}

for (const revokedDuringRead of [false, true]) test('remote Git review uses local read capability and rechecks it after awaiting Git: ' + revokedDuringRead, async t => {
  const h = await fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: h.root });
  await writeFile(join(h.root, 'local-only.ts'), 'actual remote workspace content\n');
  const input = { connectionId: h.task.connectionId, taskId: h.task.id, roundId: h.task.currentRoundId, offset: 0 };
  const job: FileJob = { ...h.job, kind: 'changes', input, hash: createHash('sha256').update(canonicalJson({ kind: 'changes', input })).digest('hex') };
  await h.state.mutate(draft => { draft.config.writeFiles = false; });
  if (revokedDuringRead) {
    const validate = h.harness.validateJob.bind(h.harness), read = h.state.read.bind(h.state);
    let revoke = false;
    t.mock.method(h.state, 'read', () => { const state = read(); if (revoke) state.config.readFiles = false; return state; });
    t.mock.method(h.harness, 'validateJob', (job: FileJob, task: ReturnType<typeof taskSchema.parse>) => {
      const binding = validate(job, task); revoke = true; return binding;
    });
  }
  const reported: Array<{ result?: unknown; error: string | null }> = [];
  h.harness.call = async (action, input) => {
    if (action === 'file-confirm') return { job, task: h.task };
    if (action === 'file-status') return job;
    if (action === 'file-result') { reported.push(input as typeof reported[number]); return {}; }
    throw new Error('Unexpected action: ' + action);
  };
  await h.harness.execute(job);
  assert.equal(reported.length, 1);
  if (revokedDuringRead) { assert.ok(reported[0]!.error); assert.equal(reported[0]!.result, undefined); }
  else {
    assert.equal(reported[0]!.error, null);
    const result = reported[0]!.result as { isGitRepository: boolean; files: Array<{ untrackedDiff: string }> };
    assert.equal(result.isGitRepository, true); assert.match(result.files[0]!.untrackedDiff, /actual remote workspace content/);
  }
});

for (const change of ['new-message', 'permission-denied'] as const) test('last-moment cache check rejects ' + change, async t => {
  const h = await fixture(t);
  const original = h.state.mutate.bind(h.state); let injected = false;
  h.state.mutate = fn => original(draft => {
    const result = fn(draft);
    if (!injected && draft.results.some(item => item.phase === 'intent')) {
      injected = true; const task = draft.cache[0]!; task.revision++;
      if (change === 'new-message') { task.messageSeq++; task.userMessageSeq = task.messageSeq; }
      else task.permissions.push({ requestId: randomUUID(), roundId: task.currentRoundId, userMessageSeq: task.userMessageSeq, title: 'Deny', description: 'No edits', scope: { toolName: 'apply_dot_changes', action: 'Edit', targets: ['new.ts'], operation: null }, consumedAt: null, status: 'denied', requestedAt: 1, resolvedAt: 2, decisionMessageSeq: task.userMessageSeq, platformBlock: null });
    }
    return result;
  });
  const reported: Array<{ error: string | null }> = [];
  h.harness.call = async (action, input) => {
    if (action === 'file-confirm') {
      assert.equal(h.state.read().results[0]?.phase, 'intent', 'intent must precede the lease request');
      return { job: h.job, task: h.task }; // Deliberately stale center snapshot.
    }
    if (action === 'file-status') return h.job;
    if (action === 'file-result') { reported.push(input as { error: string | null }); return {}; }
    throw new Error('Unexpected action: ' + action);
  };
  await h.harness.execute(h.job);
  assert.equal(readSource(h.root, 'new.ts').content, null);
  assert.ok(reported[0]?.error); assert.equal(h.state.read().results.length, 0);
});

test('expired orphan lease is reconciled after restart and no longer blocks stop', async t => {
  const h = await fixture(t);
  const job = { ...h.job, expiresAt: Date.now() - 1000 };
  const centerState = new RemoteStateStore(join(h.dir, 'center')); await centerState.load();
  await centerState.mutate(draft => { draft.jobs = [job]; });
  const center = new RemoteCenter(centerState, {} as BridgeEngine, async () => {});
  h.harness.call = async action => {
    if (action === 'file-leases') return { jobs: [job], cursor: null };
    throw new Error('Unexpected action: ' + action);
  };
  assert.equal(h.state.read().results.length, 0);
  await h.harness.reconcileLeases();
  const reopened = new RemoteStateStore(h.state.dir); await reopened.load();
  const client = new RemoteClient(reopened, h.dir); t.after(() => client.close());
  const harness = client as unknown as ClientHarness;
  harness.call = async (action, input) => {
    if (action === 'file-status') return job;
    if (action === 'file-result') {
      const result = input as { error: string | null; result?: unknown };
      assert.ok(result.error); assert.equal(result.result, undefined);
      await centerState.mutate(draft => { draft.jobs[0]!.status = 'failed'; draft.jobs[0]!.error = result.error; });
      return {};
    }
    throw new Error('Unexpected action: ' + action);
  };
  const stopped = center.settleStop(job.taskId);
  await harness.flushResults(); await stopped;
  assert.equal(reopened.read().results.length, 0);
  assert.equal(centerState.read().jobs[0]?.status, 'failed');
  assert.equal(readSource(h.root, 'new.ts').content, null);
});

test('same-peer permission changes retain the client held by provider sessions', async t => {
  const h = await fixture(t);
  t.mock.method(RemoteClient.prototype, 'pump', async () => {});
  const runtime = new RemoteRuntime({ readyToDispatch: () => false } as BridgeEngine, h.state.dir, async () => {});
  await runtime.start(); t.after(() => runtime.close());
  const sessionClient = runtime.client;
  assert.ok(sessionClient);
  await runtime.configure({ ...runtime.state.read().config, readFiles: false, writeFiles: false });
  assert.equal(runtime.client, sessionClient);
  assert.equal(runtime.backend(), sessionClient);
  assert.equal((sessionClient as unknown as ClientHarness).closed, false);
});

test('listener startup failures preserve status/configuration recovery', async t => {
  const h = await fixture(t);
  const runtime = new RemoteRuntime({ readyToDispatch: () => false } as BridgeEngine, join(h.dir, 'runtime'), async () => {});
  await runtime.state.mutate(draft => { draft.config.mode = 'center'; draft.config.host = 'invalid host'; });
  let fail = true;
  t.mock.method(runtime.center, 'start', async () => { if (fail) throw new Error('EADDRINUSE or invalid host'); runtime.center.endpoint = 'http://127.0.0.1:47823'; });
  await assert.doesNotReject(runtime.start());
  t.after(() => runtime.close());
  assert.equal(runtime.status().connected, false); assert.match(runtime.status().error ?? '', /could not start/);
  fail = false;
  const repaired = await runtime.configure({ ...runtime.state.read().config, host: '127.0.0.1' });
  assert.equal(repaired.error, null); assert.equal(repaired.connected, true);
});

test('a user message still in flight blocks an older file operation', async t => {
  const h = await fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refused = false;
  h.harness.call = async (action, input) => {
    if (action === 'message') {
      await gate; const task = structuredClone(h.task);
      task.revision++; task.messageSeq++; task.userMessageSeq = task.messageSeq;
      return task;
    }
    if (action === 'file-confirm') return { job: h.job, task: h.task };
    if (action === 'file-status') return h.job;
    if (action === 'file-result') { refused = !!(input as { error: string | null }).error; return {}; }
    throw new Error('Unexpected action: ' + action);
  };
  const saved = h.client.addMessage({ id: h.task.id, revision: h.task.revision, operationId: randomUUID(), body: 'Do not edit files', kind: 'requirement' });
  try { await h.harness.execute(h.job); } finally { release(); }
  await saved;
  assert.equal(refused, true); assert.equal(readSource(h.root, 'new.ts').content, null);
});
