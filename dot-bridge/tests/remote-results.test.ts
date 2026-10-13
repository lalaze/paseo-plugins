import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../server/store';
import { BridgeEngine } from '../server/engine';
import { RemoteStateStore, type FileJob } from '../server/remote-state';
import { RemoteCenter } from '../server/remote-center';
import { canonicalJson } from '../shared/mcp';
import { withDispatch } from '../shared/machine';
import { sourceHash } from '../server/local-files';
import type { LocalReceipt } from '../shared/local-files';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-results-'));
  const store = await BridgeStore.open(join(dir, 'data'));
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const state = new RemoteStateStore(join(dir, 'center')); await state.load();
  await state.mutate(draft => { draft.config.mode = 'center'; });
  const center = new RemoteCenter(state, engine, async () => {});
  const device = await center.createDevice({ name: 'probe', workspaceIds: ['ws'], capabilities: { chat: true, attachments: false, readFiles: true, writeFiles: true } });
  const { task } = await engine.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws', cwd: '/remote/workspace', body: 'Review', systemPrompt: '', attachments: [], remoteOrigin: { deviceId: device.device.id, workspaceId: 'ws' } });
  await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
  const identity = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId }; await engine.claimTask(identity);
  t.after(async () => { await center.stop(); engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { state, store, engine, center, device, task, identity };
}

for (const change of ['stop', 'new-message', 'read-capability', 'expiry', 'file-denial', 'file-scope'] as const) {
  test('late remote review result is fenced after ' + change, { timeout: 5000 }, async t => {
    const h = await fixture(t);
    const pending = h.center.requestFile('changes', { ...h.identity, offset: 0 });
    // Observe the queued journal before changing task state; the request is now awaiting a worker.
    await h.state.mutate(() => {});
    const rejected = assert.rejects(pending);
    if (change === 'stop') await h.engine.cancelRequest({ id: h.task.id, revision: h.engine.task(h.task.id).revision, operationId: randomUUID() });
    if (change === 'new-message') await h.engine.addMessage({ id: h.task.id, revision: h.engine.task(h.task.id).revision, operationId: randomUUID(), body: 'Different request', kind: 'requirement' });
    if (change === 'read-capability') await h.state.mutate(draft => { draft.devices[0]!.capabilities.readFiles = false; });
    if (change === 'file-denial' || change === 'file-scope') {
      const requestId = randomUUID();
      await h.engine.requestPermission({ ...h.identity, requestId, userMessageSeq: h.engine.task(h.task.id).userMessageSeq, title: 'Scoped read', description: 'Scope changed during remote work', scope: { toolName: 'read_dot_file', action: 'Read', targets: ['allowed.ts'] } });
      await h.engine.respondPermission({ taskId: h.task.id, requestId, decision: change === 'file-denial' ? 'denied' : 'approved' });
    }
    await h.state.mutate(draft => {
      const job = draft.jobs[0]!; job.status = 'done';
      if (change === 'expiry') job.expiresAt = Date.now() - 1;
      job.result = { files: [{ path: 'outside-scope.ts', previousPath: null }], source: 'must not reach Dot' };
    });
    await rejected;
  });
}

for (const status of ['done', 'leased'] as const) test('exact remote write replay retrieves a consumed approval receipt from ' + status, async t => {
  const h = await fixture(t), operationId = randomUUID(), requestId = randomUUID();
  const changes = [{ path: 'main.ts', expectedSha256: null, content: 'new' }];
  await h.engine.requestPermission({ ...h.identity, requestId, userMessageSeq: 1, title: 'Write', description: 'Exact requested bytes', scope: { toolName: 'apply_dot_changes', action: 'Write', targets: ['main.ts'], operation: { kind: 'files', operationId, changes: [{ path: 'main.ts', expectedSha256: null, contentSha256: sourceHash('new') }] } } });
  await h.engine.respondPermission({ taskId: h.task.id, requestId, decision: 'approved' });
  const input = { ...h.identity, operationId, userMessageSeq: h.engine.task(h.task.id).userMessageSeq, changes };
  const receipt: LocalReceipt = { operationId, roundId: h.identity.roundId, status: 'applied', files: [{ path: 'main.ts', action: 'create', beforeSha256: null, afterSha256: sourceHash('new') }], conflicts: [], at: Date.now() };
  await h.engine.recordRemoteReceipt(input, receipt);
  const job: FileJob = { id: randomUUID(), deviceId: h.device.device.id, taskId: h.task.id, roundId: h.identity.roundId, userMessageSeq: input.userMessageSeq, kind: 'apply', input, hash: createHash('sha256').update(canonicalJson({ kind: 'apply', input })).digest('hex'), expiresAt: Date.now() - 1, status, ...(status === 'done' ? { result: receipt } : {}), error: null };
  await h.state.mutate(draft => { draft.jobs.push(job); });
  await h.engine.cancelRequest({ id: h.task.id, revision: h.engine.task(h.task.id).revision, operationId: randomUUID() });
  assert.deepEqual(await h.center.requestFile('apply', input), receipt);
  assert.equal(h.state.read().jobs.length, 1); assert.equal(h.state.read().jobs[0]!.status, 'done');
  await assert.rejects(h.center.requestFile('apply', { ...input, changes: [{ ...changes[0]!, content: 'other bytes' }] }), /content|mismatch/i);
  await h.state.mutate(draft => { draft.devices[0]!.revoked = true; });
  await assert.rejects(h.center.requestFile('apply', input));
});
