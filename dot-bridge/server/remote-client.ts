import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentRound, taskSchema, type Task } from '../shared/schema';
import { remoteDeviceSchema } from '../shared/remote';
import { attachmentSchema, ATTACHMENT_CHUNK_BYTES } from '../shared/attachments';
import { canonicalJson } from '../shared/mcp';
import type { PermissionOperation } from '../shared/permissions';
import { assertPermissionAccess, assertWorkspaceReviewAccess } from './permissions';
import type { BridgeEngine } from './engine';
import { ActivityLog } from './activity';
import { canonicalWorkspace, listSources, readSource, applyLocalChanges, readChangeJournal, readChangeReceipt, sourceHash } from './local-files';
import { readWorkspaceChanges } from './workspace-changes';
import { AttachmentStore } from './attachments';
import { receiveChunk, clearTransfer, saveDeliveredFile } from './attachment-transfers';
import { RemoteStateStore, fileJobSchema, type FileJob } from './remote-state';
import { remoteCall, remoteUrl } from './remote-http';

/** Check server replies before selecting any local workspace or touching files. */
export function assertRemoteJobIdentity(job: FileJob, task: Task): void {
  if (task.id !== job.taskId || task.remoteOrigin?.deviceId !== job.deviceId || task.remoteOrigin.workspaceId !== task.workspaceId || task.workspaceRoot !== null) throw new Error('Remote file task identity mismatch');
  if (job.input.taskId !== job.taskId || job.input.roundId !== job.roundId || job.input.connectionId !== task.connectionId) throw new Error('Remote file request identity mismatch');
  if (job.kind === 'apply' && job.input.userMessageSeq !== job.userMessageSeq) throw new Error('Remote file request version mismatch');
  const fingerprint = createHash('sha256').update(canonicalJson({ kind: job.kind, input: job.input })).digest('hex');
  if (fingerprint !== job.hash) throw new Error('Remote file request content changed');
}
export function assertRemoteWritePermission(task: Task, paths: string[], operation?: PermissionOperation): void {
  assertPermissionAccess(task, 'apply_dot_changes', paths, operation);
}
export class RemoteClient {
  readonly activity = new ActivityLog();
  connected = false;
  error: string | null = null;
  private ready = false;
  private pendingInputs = 0;
  private async withInput<T>(action: () => Promise<T>): Promise<T> {
    this.pendingInputs++;
    try { return await action(); } finally { this.pendingInputs--; }
  }
  private pumping: Promise<void> | null = null;
  private closed = false;
  private lifecycle = new AbortController();
  constructor(readonly state: RemoteStateStore, readonly dataDir: string) {}
  private async call(action: string, input: unknown): Promise<unknown> {
    const config = this.state.read();
    if (this.closed || config.config.mode !== 'remote' || !config.token) throw new Error('Remote mode is not connected');
    return remoteCall(remoteUrl(config.config.url, config.config.privateHttp), config.token, action, input, this.lifecycle.signal);
  }
  tasks(): Task[] {
    const state = this.state.read();
    return state.cache.filter(task => state.bindings.some(binding => binding.taskId === task.id)).map(task => this.decorate(task));
  }
  task(id: string): Task { const task = this.tasks().find(item => item.id === id); if (!task) throw new Error('Remote task is not cached on this device'); return task; }
  private decorate(task: Task): Task {
    const state = this.state.read(), copy = structuredClone(task);
    for (const attachment of copy.attachments) {
      delete attachment.localPath;
      const delivery = state.deliveries.find(item => item.taskId === copy.id && item.attachmentId === attachment.id && item.sha256 === attachment.sha256);
      if (delivery) attachment.localPath = delivery.path;
    }
    return copy;
  }
  private async accept(raw: unknown): Promise<Task> {
    const task = taskSchema.parse(raw);
    if (!task.remoteOrigin || task.workspaceRoot !== null) throw new Error('Center returned a non-remote task');
    await this.state.mutate(draft => {
      const binding = draft.bindings.find(item => item.taskId === task.id);
      if (!binding || binding.workspaceId !== task.workspaceId || binding.cwd !== task.provider?.cwd) throw new Error('Remote task workspace binding mismatch');
      const index = draft.cache.findIndex(item => item.id === task.id);
      if (index >= 0) { if (draft.cache[index].revision > task.revision) return; draft.cache[index] = task; }
      else draft.cache.push(task);
    });
    return this.task(task.id);
  }
  async restoreTask(id: string): Promise<void> {
    if (!this.state.read().bindings.some(binding => binding.taskId === id)) throw new Error('This remote conversation has no local workspace binding');
    await this.accept(await this.call('task', { id }));
  }
  transportKey(): string { const state = this.state.read(); return 'remote:' + createHash('sha256').update(state.config.url + '\n' + state.token).digest('hex'); }
  readyToDispatch(): boolean { return this.connected && this.ready; }
  connectionError(): string | null { return this.error; }
  changeContents(operationId: string) { return readChangeJournal(this.dataDir, operationId); }

  async providerPrompt(input: Parameters<BridgeEngine['providerPrompt']>[0]): Promise<{ task: Task; duplicate: boolean }> {
    return this.withInput(() => this.sendPrompt(input));
  }
  private async sendPrompt(input: Parameters<BridgeEngine['providerPrompt']>[0]): Promise<{ task: Task; duplicate: boolean }> {
    if (input.remoteOrigin) throw new Error('Remote origin is assigned by the center');
    const config = this.state.read().config;
    if (!config.workspaceIds.includes(input.workspaceId)) throw new Error('This workspace is not enabled for the remote connection');
    const cwd = canonicalWorkspace(input.cwd);
    await this.state.mutate(draft => {
      const binding = draft.bindings.find(item => item.taskId === input.id);
      if (binding && (binding.cwd !== cwd || binding.workspaceId !== input.workspaceId)) throw new Error('Local binding cannot change');
      if (!binding) draft.bindings.push({ taskId: input.id, workspaceId: input.workspaceId, cwd });
      if (draft.stops.some(item => item.taskId === input.id)) throw new Error('Waiting for the center to acknowledge a stop');
    });
    const reply = z.object({ task: taskSchema, duplicate: z.boolean() }).parse(await this.call('prompt', { ...input, cwd }));
    const task = await this.accept(reply.task);
    this.connected = true; this.error = null; return { task, duplicate: reply.duplicate };
  }
  async respondPermission(input: Parameters<BridgeEngine['respondPermission']>[0]) { return this.withInput(() => this.sendPermission(input)); }
  private async sendPermission(input: Parameters<BridgeEngine['respondPermission']>[0]) {
    const reply = await this.call('permission', input);
    await this.restoreTask(input.taskId);
    return z.object({}).passthrough().parse(reply) as Awaited<ReturnType<BridgeEngine['respondPermission']>>;
  }
  async cancelRequest(input: Parameters<BridgeEngine['cancelRequest']>[0]): Promise<Task> { return this.withInput(() => this.sendCancel(input)); }
  private async sendCancel(input: Parameters<BridgeEngine['cancelRequest']>[0]): Promise<Task> {
    const task = this.task(input.id);
    await this.state.mutate(draft => { if (!draft.stops.some(item => item.taskId === task.id && item.roundId === task.currentRoundId)) draft.stops.push({ taskId: task.id, roundId: task.currentRoundId, operationId: input.operationId }); });
    // The durable local stop blocks file operations even if this network call fails.
    await this.flushStops();
    return this.task(input.id);
  }
  private async flushStops() {
    for (const stop of this.state.read().stops) {
      const task = taskSchema.parse(await this.call('task', { id: stop.taskId }));
      if (task.currentRoundId === stop.roundId && !currentRound(task).stop.requested && !['completed', 'failed', 'stopped'].includes(task.status)) {
        await this.accept(await this.call('cancel', { id: task.id, revision: task.revision, operationId: stop.operationId }));
      } else await this.accept(task);
      const latest = this.task(stop.taskId);
      if (latest.currentRoundId !== stop.roundId || ['stopped', 'failed', 'completed'].includes(latest.status)) await this.state.mutate(draft => { draft.stops = draft.stops.filter(item => item.taskId !== stop.taskId || item.roundId !== stop.roundId); });
    }
  }
  async addMessage(input: Parameters<BridgeEngine['addMessage']>[0]) { return this.withInput(async () => this.accept(await this.call('message', input))); }
  async createRound(input: Parameters<BridgeEngine['createRound']>[0]) { return this.withInput(async () => this.accept(await this.call('next', input))); }
  async retryRound(input: Parameters<BridgeEngine['retryRound']>[0]) { return this.withInput(async () => this.accept(await this.call('retry', input))); }
  async closeLocal(input: Parameters<BridgeEngine['closeLocal']>[0]) { return this.withInput(async () => this.accept(await this.call('local-close', input))); }
  async historyForTask(id: string, cursor: string | null) { return await this.call('history', { id, cursor }) as ReturnType<BridgeEngine['historyForTask']>; }
  async uploadAttachment(input: Parameters<BridgeEngine['uploadAttachment']>[0]) { return this.withInput(() => this.sendAttachment(input)); }
  private async sendAttachment(input: Parameters<BridgeEngine['uploadAttachment']>[0]) {
    const { actor: _actor, connectionId: _connectionId, ...args } = input;
    const result = await this.call('attachment-upload', args);
    await this.restoreTask(input.id); return result as Awaited<ReturnType<BridgeEngine['uploadAttachment']>>;
  }
  async readAttachment(id: string, attachmentId: string) { return await this.call('attachment-read', { id, attachmentId }) as Awaited<ReturnType<BridgeEngine['readAttachment']>>; }
  async readAttachmentChunk(id: string, attachmentId: string, index: number) { return await this.call('attachment-chunk', { id, attachmentId, index }) as Awaited<ReturnType<BridgeEngine['readAttachmentChunk']>>; }

  async pump(): Promise<void> {
    if (this.pumping || this.closed || this.state.read().config.mode !== 'remote') return this.pumping ?? Promise.resolve();
    this.pumping = this.run().catch(() => { this.connected = false; this.error = 'Center connection unavailable; cached history retained and new file operations paused'; }).finally(() => { this.pumping = null; });
    return this.pumping;
  }
  private async run() {
    const hello = z.object({ device: remoteDeviceSchema, ready: z.boolean() }).parse(await this.call('hello', {}));
    this.ready = hello.ready; this.connected = true; this.error = null;
    await this.reconcileLeases();
    await this.flushResults();
    await this.flushStops();
    let cursor: string | null = null; const seen = new Set<string>();
    do {
      const page = z.object({ entries: z.array(z.object({ id: z.string().uuid(), revision: z.number().int() })), cursor: z.string().uuid().nullable() }).parse(await this.call('catalog', { cursor }));
      for (const entry of page.entries) {
        const state = this.state.read();
        if (!state.bindings.some(binding => binding.taskId === entry.id)) continue;
        if (state.cache.find(task => task.id === entry.id)?.revision !== entry.revision) await this.restoreTask(entry.id);
      }
      cursor = page.cursor; if (cursor && seen.has(cursor)) throw new Error('Center cursor repeated'); if (cursor) seen.add(cursor);
    } while (cursor);
    const jobs = z.object({ jobs: z.array(fileJobSchema) }).parse(await this.call('file-poll', {}));
    for (const job of jobs.jobs) await this.execute(job);
    if (hello.device.capabilities.attachments) for (const task of this.tasks()) for (const attachment of task.attachments) {
      if (attachment.author !== 'dot') continue;
      const saved = this.state.read().deliveries.find(item => item.taskId === task.id && item.attachmentId === attachment.id);
      if (saved) { if (!saved.confirmed) { await this.call('attachment-saved', { taskId: task.id, attachmentId: attachment.id, path: saved.path }); await this.state.mutate(draft => { const record = draft.deliveries.find(item => item.taskId === task.id && item.attachmentId === attachment.id); if (record) record.confirmed = true; }); } continue; }
      await this.download(task, attachment.id);
    }
  }
  private validateJob(job: FileJob, task: Task) {
    if (this.pendingInputs) throw new Error('Local user input is still being saved');
    assertRemoteJobIdentity(job, task);
    const state = this.state.read(), binding = state.bindings.find(item => item.taskId === job.taskId), round = currentRound(task);
    if (this.closed || state.config.mode !== 'remote' || !binding || !state.config.workspaceIds.includes(binding.workspaceId) || binding.workspaceId !== task.workspaceId || binding.cwd !== task.provider?.cwd) throw new Error('Remote workspace is not bound locally');
    if (!(job.kind === 'apply' ? state.config.writeFiles : state.config.readFiles)) throw new Error('File capability disabled on this device');
    if (state.stops.some(item => item.taskId === task.id && item.roundId === job.roundId) || job.expiresAt <= Date.now() || task.currentRoundId !== job.roundId || task.userMessageSeq !== job.userMessageSeq || round.stop.requested || !round.claim || !['claimed', 'running', 'waiting_user'].includes(task.status)) throw new Error('Stale, stopped or expired remote file operation');
    if (job.kind === 'apply') {
      const changes = job.input.changes as Parameters<typeof applyLocalChanges>[0]['changes'];
      assertRemoteWritePermission(task, changes.map(change => change.path), { kind: 'files', operationId: String(job.input.operationId), changes: changes.map(change => ({ path: change.path, expectedSha256: change.expectedSha256, contentSha256: change.content === null ? null : sourceHash(change.content) })) });
    } else if (job.kind === 'changes') assertWorkspaceReviewAccess(task);
    else assertPermissionAccess(task, job.kind === 'list' ? 'list_dot_files' : 'read_dot_file', [String(job.kind === 'list' ? job.input.directory || '/' : job.input.path)]);
    return binding;
  }
  /** Recover legacy orphan leases too, including expired jobs. Recovery never executes them. */
  private async reconcileLeases() {
    let cursor: string | null = null;
    do {
      const page = z.object({ jobs: z.array(fileJobSchema), cursor: z.string().uuid().nullable() }).parse(await this.call('file-leases', { cursor }));
      for (const job of page.jobs) await this.state.mutate(draft => {
        if (!draft.results.some(item => item.job.id === job.id)) draft.results.push({ job, phase: 'intent', error: null });
      });
      if (page.cursor && cursor === page.cursor) throw new Error('Lease cursor repeated');
      cursor = page.cursor;
    } while (cursor);
  }
  private async flushResults() {
    for (const pending of this.state.read().results) {
      if (pending.phase === 'intent') {
        const result = pending.job.kind === 'apply' ? readChangeReceipt(this.dataDir, String(pending.job.input.operationId)) : null;
        await this.state.mutate(draft => {
          const item = draft.results.find(value => value.job.id === pending.job.id)!;
          item.phase = 'ready';
          if (result) { item.result = result; item.error = null; }
          else item.error = 'Interrupted before a durable result was recorded; no automatic re-execution';
        });
      }
      const item = this.state.read().results.find(value => value.job.id === pending.job.id)!;
      const remote = fileJobSchema.parse(await this.call('file-status', { id: item.job.id }));
      if (remote.hash !== item.job.hash) throw new Error('Recovered lease content changed');
      // A stop may fail a queued job before its lease request arrives. No local result means
      // there was no filesystem execution to contradict that terminal center outcome.
      if (!(remote.status === 'failed' && item.result === undefined)) {
        await this.call('file-result', { id: item.job.id, ...(item.result !== undefined ? { result: item.result } : {}), error: item.error });
      }
      await this.state.mutate(draft => { draft.results = draft.results.filter(value => value.job.id !== item.job.id); });
    }
  }
  private async execute(job: FileJob) {
    if (this.state.read().results.some(item => item.job.id === job.id)) { await this.flushResults(); return; }
    // Persist before requesting a lease. Even a crash before the response now has an outbox entry.
    await this.state.mutate(draft => { draft.results.push({ job, phase: 'intent', error: null }); });
    let result: unknown, error: string | null = null;
    try {
      const confirmed = z.object({ job: fileJobSchema, task: taskSchema }).parse(await this.call('file-confirm', { id: job.id }));
      if (confirmed.job.id !== job.id || confirmed.job.taskId !== job.taskId || confirmed.job.roundId !== job.roundId || confirmed.job.kind !== job.kind || confirmed.job.userMessageSeq !== job.userMessageSeq || canonicalJson(confirmed.job.input) !== canonicalJson(job.input) || confirmed.job.hash !== job.hash || confirmed.job.deviceId !== job.deviceId) throw new Error('File job changed');
      // Queue the confirmed snapshot behind concurrent local input saves. accept never replaces
      // a newer cache revision; re-read the cache after its final await, not confirmed.task.
      await this.accept(confirmed.task);
      const latest = this.task(job.taskId);
      // No await between this latest-cache/stop/permission check and synchronous file access.
      const binding = this.validateJob(confirmed.job, latest);
      if (job.kind === 'list') result = { ...listSources(binding.cwd, String(job.input.directory ?? ''), Number(job.input.offset ?? 0)), userMessageSeq: job.userMessageSeq };
      else if (job.kind === 'read') { const { mode: _mode, ...file } = readSource(binding.cwd, String(job.input.path)); result = { ...file, userMessageSeq: job.userMessageSeq }; }
      else if (job.kind === 'changes') {
        const changes = await readWorkspaceChanges(binding.cwd, Number(job.input.offset ?? 0), this.lifecycle.signal);
        // Git reads await child processes. Honor new input, stops, expiry and changed device scope before returning content.
        this.validateJob(confirmed.job, this.task(job.taskId));
        assertWorkspaceReviewAccess(this.task(job.taskId), changes.files.flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]));
        result = { ...changes, userMessageSeq: job.userMessageSeq };
      }
      else result = applyLocalChanges({ dataDir: this.dataDir, root: binding.cwd, taskId: job.taskId, roundId: job.roundId, userMessageSeq: job.userMessageSeq, operationId: z.string().uuid().parse(job.input.operationId), changes: job.input.changes as Parameters<typeof applyLocalChanges>[0]['changes'], at: Date.now() });
    } catch { result = undefined; error = 'Remote file operation refused or failed; inspect workspace, permission, stop state and hashes'; }
    await this.state.mutate(draft => {
      let item = draft.results.find(value => value.job.id === job.id);
      if (!item) { item = { job, phase: 'ready', error }; draft.results.push(item); }
      item.phase = 'ready'; item.result = result; item.error = error;
    });
    await this.flushResults();
  }
  private async download(task: Task, attachmentId: string) {
    const attachment = task.attachments.find(item => item.id === attachmentId)!;
    let bytes: Buffer | undefined;
    if (!attachment.size) bytes = Buffer.alloc(0);
    else for (let index = 0; index < Math.ceil(attachment.size / ATTACHMENT_CHUNK_BYTES); index++) {
      const chunk = z.object({ attachment: attachmentSchema, content: z.string(), done: z.boolean() }).parse(await this.call('attachment-chunk', { id: task.id, attachmentId, index }));
      if (chunk.attachment.sha256 !== attachment.sha256 || chunk.attachment.size !== attachment.size) throw new Error('Attachment changed');
      bytes = receiveChunk(this.dataDir, { ...attachment, taskId: task.id, connectionId: task.connectionId, operationId: attachment.id, index, content: chunk.content, mediaType: attachment.mediaType, name: attachment.name }, Date.now()).bytes;
    }
    if (!bytes) throw new Error('Attachment transfer incomplete');
    const blob = await new AttachmentStore(this.dataDir).put(bytes);
    if (blob !== attachment.sha256) throw new Error('Attachment hash mismatch');
    const path = saveDeliveredFile(this.dataDir, task.id, attachment.id, attachment.name, bytes);
    await this.state.mutate(draft => { draft.deliveries.push({ taskId: task.id, attachmentId, path, sha256: attachment.sha256, confirmed: false }); });
    clearTransfer(this.dataDir, task.id, attachment.id);
    await this.call('attachment-saved', { taskId: task.id, attachmentId, path });
  }
  async close() { this.closed = true; this.lifecycle.abort(); await this.pumping; }
}
