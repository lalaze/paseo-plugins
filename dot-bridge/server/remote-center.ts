import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import * as rpc from '../shared/rpc';
import { attachmentContentSchema } from '../shared/attachments';
import { localReceiptSchema } from '../shared/local-files';
import { canonicalJson, toolInputSchemas } from '../shared/mcp';
import { currentRound, type Task } from '../shared/schema';
import type { RemoteDevice } from '../shared/remote';
import type { BridgeEngine } from './engine';
import { RemoteStateStore, type FileJob } from './remote-state';
import { readRemoteBody, REMOTE_PATH, REMOTE_MAX_BYTES } from './remote-http';
import { sourceHash, validateLocalPath } from './local-files';
import { assertWorkspaceReviewAccess } from './permissions';

const envelope = z.object({ action: z.string().max(80), input: z.unknown() }).strict();
const promptSchema = z.object({
  id: z.string().uuid(), operationId: z.string().uuid(), clientMessageId: z.string().min(1).max(500),
  workspaceId: z.string().min(1).max(200), cwd: z.string().min(1).max(4000),
  body: z.string().min(1).max(20000), systemPrompt: z.string().max(20000), attachments: z.array(attachmentContentSchema).max(16),
  steerRoundId: z.string().uuid().optional(),
}).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function deviceCanUse(device: RemoteDevice, workspaceId: string, capability: keyof RemoteDevice['capabilities']): boolean {
  return !device.revoked && device.capabilities[capability] && device.workspaceIds.includes(workspaceId);
}
/** Never return center filesystem paths as remote delivery locations. */
export function remoteTaskView(task: Task): Task {
  const copy = structuredClone(task);
  for (const attachment of copy.attachments) delete attachment.localPath;
  return copy;
}
export class RemoteCenter {
  private server: Server | null = null;
  private active = 0;
  private closing = false;
  private controllers = new Set<AbortController>();
  endpoint = '';
  error: string | null = null;
  constructor(readonly state: RemoteStateStore, readonly engine: BridgeEngine, private tick: () => Promise<void>) {}
  async start(): Promise<void> {
    const config = this.state.read().config;
    if (config.mode !== 'center' || this.server) return;
    this.closing = false;
    if (/[\s\/\\]/.test(config.host)) throw new Error('Invalid center bind host');
    this.server = createServer(async (request, response) => {
      const answer = (status: number, body: unknown) => { if (response.destroyed || response.writableEnded) return; const text = JSON.stringify(body); if (Buffer.byteLength(text) > REMOTE_MAX_BYTES) { response.writeHead(413); response.end(); return; } response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(text); };
      if (this.closing || this.active >= 32) { answer(503, { ok: false, error: 'Center unavailable' }); return; }
      if (request.url !== REMOTE_PATH || request.method !== 'POST' || request.headers.origin) { answer(404, { ok: false, error: 'Not found' }); return; }
      const auth = request.headers.authorization;
      const device = typeof auth === 'string' && auth.startsWith('Bearer ') ? this.authenticate(auth.slice(7)) : undefined;
      if (!device) { answer(401, { ok: false, error: 'Unauthorized device' }); return; }
      this.active++;
      try {
        const parsed = envelope.parse(await readRemoteBody(request));
        const fresh = this.device(device.id);
        const value = await this.handle(fresh, parsed.action, parsed.input);
        answer(200, { ok: true, value });
      } catch { answer(400, { ok: false, error: 'Center refused the request; check device scope, task state and version' }); }
      finally { this.active--; }
    });
    try {
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(config.port, config.host, () => { this.server!.off('error', reject); resolve(); }); });
      const address = this.server.address(); this.endpoint = 'http://' + (config.host.includes(':') ? '[' + config.host + ']' : config.host) + ':' + (typeof address === 'object' && address ? address.port : config.port);
      this.error = null;
    } catch (error) { this.error = 'Center listener could not start'; await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    this.closing = true; for (const controller of this.controllers) controller.abort();
    const server = this.server; this.server = null; this.endpoint = '';
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  private authenticate(token: string) {
    const digest = Buffer.from(hash(token));
    return this.state.read().devices.find(device => !device.revoked && device.tokenHash.length === digest.length && timingSafeEqual(Buffer.from(device.tokenHash), digest));
  }
  private device(id: string) {
    const device = this.state.read().devices.find(item => item.id === id && !item.revoked);
    if (!device || this.state.read().config.mode !== 'center' || this.closing) throw new Error('Revoked device');
    return device;
  }
  private owned(device: RemoteDevice, id: string, capability: keyof RemoteDevice['capabilities'] = 'chat'): Task {
    const task = this.engine.task(id);
    if (task.remoteOrigin?.deviceId !== device.id || !deviceCanUse(this.device(device.id), task.remoteOrigin.workspaceId, capability)) throw new Error('Task not permitted');
    return task;
  }
  async createDevice(input: { name: string; capabilities: RemoteDevice['capabilities']; workspaceIds: string[] }) {
    if (this.state.read().config.mode !== 'center') throw new Error('Enable center mode before creating devices');
    const token = randomBytes(32).toString('base64url');
    const device: RemoteDevice = { id: randomUUID(), ...input, revoked: false, createdAt: Date.now() };
    await this.state.mutate(draft => { draft.devices.push({ ...device, tokenHash: hash(token) }); });
    return { device, token };
  }
  async revokeDevice(id: string) {
    await this.state.mutate(draft => { const device = draft.devices.find(item => item.id === id); if (!device) throw new Error('Unknown device'); device.revoked = true; for (const job of draft.jobs) if (job.deviceId === id && job.status === 'queued') { job.status = 'failed'; job.error = 'Device revoked'; } });
  }
  private async handle(device: RemoteDevice, action: string, input: unknown): Promise<unknown> {
    if (action === 'hello') return { device: (({ tokenHash: _token, ...rest }) => rest)(this.device(device.id)), ready: this.engine.readyToDispatch() };
    if (action === 'catalog') {
      const { cursor } = z.object({ cursor: z.string().uuid().nullable().default(null) }).strict().parse(input);
      const tasks = this.engine.tasks().filter(task => task.remoteOrigin?.deviceId === device.id && deviceCanUse(device, task.workspaceId, 'chat')).sort((a,b) => a.id.localeCompare(b.id));
      const remaining = tasks.filter(task => !cursor || task.id > cursor), page = remaining.slice(0, 200);
      return { entries: page.map(task => ({ id: task.id, revision: task.revision })), cursor: remaining.length > page.length ? page.at(-1)!.id : null };
    }
    if (action === 'prompt') {
      const args = promptSchema.parse(input);
      if (!deviceCanUse(device, args.workspaceId, 'chat') || (args.attachments.length && !deviceCanUse(device, args.workspaceId, 'attachments'))) throw new Error('Scope refused');
      const prior = this.engine.tasks().find(task => task.id === args.id);
      if (prior) this.owned(device, prior.id);
      const result = await this.engine.providerPrompt({ ...args, remoteOrigin: { deviceId: device.id, workspaceId: args.workspaceId } });
      void this.tick(); return { ...result, task: remoteTaskView(result.task) };
    }
    if (action === 'task') { const args = rpc.taskGet.input.parse(input); return remoteTaskView(this.owned(device, args.id)); }
    if (action === 'history') { const args = rpc.taskHistory.input.parse(input); this.owned(device, args.id); return this.engine.historyForTask(args.id, args.cursor); }
    if (action === 'permission') { const args = rpc.taskPermissionRespond.input.parse(input); this.owned(device, args.taskId); const result = await this.engine.respondPermission(args); void this.tick(); return result; }
    if (action === 'message') { const args = rpc.taskMessageAdd.input.parse(input); this.owned(device, args.id); const task = await this.engine.addMessage(args); void this.tick(); return remoteTaskView(task); }
    if (action === 'cancel' || action === 'next' || action === 'retry') {
      const args = rpc.taskCancelRequest.input.parse(input); this.owned(device, args.id);
      const task = action === 'cancel' ? await this.engine.cancelRequest(args) : action === 'next' ? await this.engine.createRound(args) : await this.engine.retryRound(args);
      void this.tick(); return remoteTaskView(task);
    }
    if (action === 'rewake') {
      const args = rpc.taskRewake.input.parse(input); this.owned(device, args.id);
      const task = await this.engine.rewakeTask(args); void this.tick(); return remoteTaskView(task);
    }
    if (action === 'local-close') {
      const args = rpc.taskLocalClose.input.parse(input); this.owned(device, args.id);
      await this.settleStop(args.id);
      const task = await this.engine.closeLocal(args); void this.tick(); return remoteTaskView(task);
    }
    if (action === 'attachment-upload') {
      const args = rpc.taskAttachmentUpload.input.parse(input); this.owned(device, args.id, 'attachments');
      const value = await this.engine.uploadAttachment({ ...args, actor: 'user' }); void this.tick(); return value;
    }
    if (action === 'attachment-read' || action === 'attachment-chunk') {
      const args = action === 'attachment-read' ? rpc.taskAttachmentRead.input.parse(input) : rpc.taskAttachmentChunkRead.input.parse(input);
      this.owned(device, args.id, 'attachments');
      const value = action === 'attachment-read' ? await this.engine.readAttachment(args.id, args.attachmentId)
        : await this.engine.readAttachmentChunk(args.id, args.attachmentId, rpc.taskAttachmentChunkRead.input.parse(input).index);
      delete value.attachment.localPath; return value;
    }
    if (action === 'attachment-saved') {
      const args = z.object({ taskId: z.string().uuid(), attachmentId: z.string().uuid(), path: z.string().min(1).max(4000) }).strict().parse(input);
      this.owned(device, args.taskId, 'attachments'); await this.engine.remoteAttachmentSaved(args.taskId, args.attachmentId, args.path); return {};
    }
    if (action === 'file-status') {
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const job = this.state.read().jobs.find(item => item.id === id && item.deviceId === device.id);
      if (!job) throw new Error('Unknown device job');
      this.owned(device, job.taskId, job.kind === 'apply' ? 'writeFiles' : 'readFiles');
      return job;
    }
    if (action === 'file-leases') {
      const { cursor } = z.object({ cursor: z.string().uuid().nullable().default(null) }).strict().parse(input);
      const jobs = this.state.read().jobs.filter(job => job.deviceId === device.id && job.status === 'leased' && (!cursor || job.id > cursor)).sort((a, b) => a.id.localeCompare(b.id));
      const page = jobs.slice(0, 200);
      return { jobs: page, cursor: jobs.length > page.length ? page.at(-1)!.id : null };
    }
    if (action === 'file-poll') {
      const jobs = this.state.read().jobs.filter(job => job.deviceId === device.id && ['queued', 'leased'].includes(job.status) && job.expiresAt > Date.now());
      return { jobs: jobs.slice(0, 4) };
    }
    if (action === 'file-confirm') {
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const job = this.state.read().jobs.find(item => item.id === id && item.deviceId === device.id);
      if (!job || !['queued', 'leased'].includes(job.status) || job.expiresAt <= Date.now()) throw new Error('Expired job');
      const task = this.owned(device, job.taskId, job.kind === 'apply' ? 'writeFiles' : 'readFiles');
      this.validateFile(job.kind, job.input, job.userMessageSeq);
      await this.state.mutate(draft => { const current = draft.jobs.find(item => item.id === id)!; if (current.expiresAt <= Date.now() || !['queued', 'leased'].includes(current.status)) throw new Error('Expired job'); current.status = 'leased'; });
      // Saving the lease yields to other requests. Do not return the earlier task snapshot.
      const latest = this.owned(device, job.taskId, job.kind === 'apply' ? 'writeFiles' : 'readFiles');
      this.validateFile(job.kind, job.input, job.userMessageSeq);
      if (job.expiresAt <= Date.now()) throw new Error('Expired job');
      return { job: { ...job, status: 'leased' }, task: remoteTaskView(latest) };
    }
    if (action === 'file-result') {
      const args = z.object({ id: z.string().uuid(), result: z.unknown().optional(), error: z.string().max(1000).nullable() }).strict().parse(input);
      const job = this.state.read().jobs.find(item => item.id === args.id && item.deviceId === device.id);
      if (!job || (!['leased', 'done', 'failed'].includes(job.status) && !(job.status === 'queued' && args.error))) throw new Error('Job not leased');
      this.owned(device, job.taskId, job.kind === 'apply' ? 'writeFiles' : 'readFiles');
      if (job.status === 'done' || job.status === 'failed') { if (canonicalJson({ result: job.result, error: job.error }) !== canonicalJson({ result: args.result, error: args.error })) throw new Error('Receipt changed'); return {}; }
      if (!args.error && job.kind === 'apply') {
        const receipt = localReceiptSchema.parse(args.result), operationId = z.string().uuid().parse(job.input.operationId);
        await this.engine.recordRemoteReceipt({ taskId: job.taskId, roundId: job.roundId, operationId, userMessageSeq: job.userMessageSeq, changes: job.input.changes as Parameters<BridgeEngine['applyLocalFiles']>[0]['changes'] }, receipt);
      }
      await this.state.mutate(draft => { const current = draft.jobs.find(item => item.id === args.id)!; current.status = args.error ? 'failed' : 'done'; current.error = args.error; current.result = args.result; });
      return {};
    }
    throw new Error('Unsupported remote operation');
  }

  async settleStop(taskId: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (this.state.read().jobs.some(job => job.taskId === taskId && job.kind === 'apply' && job.status === 'leased')) {
      if (this.closing || Date.now() >= deadline) throw new Error('Waiting for remote file-operation receipt before confirming stop');
      await delay(250);
    }
    await this.state.mutate(draft => { for (const job of draft.jobs) if (job.taskId === taskId && job.status === 'queued') { job.status = 'failed'; job.error = 'Task stopped before execution'; } });
  }

  private validateFile(kind: FileJob['kind'], raw: unknown, userMessageSeq?: number): Task {
    if (kind === 'apply') {
      const input = toolInputSchemas.apply_dot_changes.parse(raw);
      return this.engine.validateRemoteFiles({ ...input, userMessageSeq: userMessageSeq ?? input.userMessageSeq }, 'apply_dot_changes', input.changes.map(change => change.path), {
        kind: 'files', operationId: input.operationId, changes: input.changes.map(change => ({ path: change.path, expectedSha256: change.expectedSha256, contentSha256: change.content === null ? null : sourceHash(change.content) })),
      });
    }
    const input = kind === 'list' ? toolInputSchemas.list_dot_files.parse(raw) : kind === 'read' ? toolInputSchemas.read_dot_file.parse(raw) : toolInputSchemas.read_dot_workspace_changes.parse(raw);
    const targets = kind === 'read' ? [toolInputSchemas.read_dot_file.parse(raw).path] : kind === 'list' ? [toolInputSchemas.list_dot_files.parse(raw).directory || '/'] : ['/'];
    return this.engine.validateRemoteFiles({ ...input, ...(userMessageSeq !== undefined ? { userMessageSeq } : {}) }, kind === 'list' ? 'list_dot_files' : kind === 'read' ? 'read_dot_file' : 'read_dot_workspace_changes', targets);
  }

  async requestFile(kind: FileJob['kind'], raw: unknown): Promise<unknown> {
    const input = kind === 'apply' ? toolInputSchemas.apply_dot_changes.parse(raw) : kind === 'read' ? toolInputSchemas.read_dot_file.parse(raw) : kind === 'changes' ? toolInputSchemas.read_dot_workspace_changes.parse(raw) : toolInputSchemas.list_dot_files.parse(raw);
    const task = this.engine.getForConnection(input.connectionId, input.taskId);
    if (!task.remoteOrigin || task.workspaceRoot !== null) throw new Error('Not a remote task');
    const device = this.device(task.remoteOrigin!.deviceId);
    this.owned(device, task.id, kind === 'apply' ? 'writeFiles' : 'readFiles');
    const fingerprint = hash(canonicalJson({ kind, input }));
    // A receipt is history, not permission to execute another write. Check identity and payload
    // before active-round/consumed-grant checks, including a crash between receipt and job saves.
    if (kind === 'apply') {
      const operationId = toolInputSchemas.apply_dot_changes.parse(input).operationId;
      const prior = this.state.read().jobs.find(job => job.deviceId === device.id && job.kind === 'apply' && job.input.operationId === operationId);
      if (prior) {
        if (prior.hash !== fingerprint) throw new Error('Operation content changed');
        if (this.hasRecordedWrite(prior)) {
          const replay = await this.recordedWrite(prior);
          this.owned(this.device(device.id), task.id, 'writeFiles');
          if (replay.found) return replay.result;
        }
      }
    }
    this.validateFile(kind, input);
    const job = await this.state.mutate(draft => {
      if (kind === 'apply') {
        const operationId = (input as { operationId: string }).operationId;
        const prior = draft.jobs.find(item => item.deviceId === device.id && item.kind === 'apply' && item.input.operationId === operationId);
        if (prior) { if (prior.hash !== fingerprint) throw new Error('Operation content changed'); return prior; }
      }
      this.validateFile(kind, input);
      if (draft.jobs.length >= 5000) throw new Error('Remote operation journal full; review before continuing');
      const value: FileJob = { id: randomUUID(), deviceId: device.id, taskId: task.id, roundId: task.currentRoundId, userMessageSeq: task.userMessageSeq, kind, input: input as unknown as Record<string, unknown>, hash: fingerprint, expiresAt: Date.now() + 60000, status: 'queued', error: null };
      draft.jobs.push(value); return value;
    });
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      for (;;) {
        this.owned(this.device(device.id), task.id, kind === 'apply' ? 'writeFiles' : 'readFiles');
        const current = this.state.read().jobs.find(item => item.id === job.id)!;
        if (kind === 'apply' && this.hasRecordedWrite(current)) {
          const replay = await this.recordedWrite(current);
          this.owned(this.device(device.id), task.id, 'writeFiles');
          if (replay.found) return replay.result;
        }
        if (current.status === 'done') {
          if (Date.now() >= current.expiresAt) throw new Error('Remote read expired before delivery');
          const latest = this.validateFile(kind, input, job.userMessageSeq);
          if (kind === 'changes') {
            const result = z.object({ files: z.array(z.object({ path: z.string(), previousPath: z.string().nullable() })).max(20) }).parse(current.result);
            const paths = result.files.flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]);
            paths.forEach(path => validateLocalPath(path));
            assertWorkspaceReviewAccess(latest, paths);
          }
          return current.result;
        }
        if (current.status === 'failed') throw new Error(current.error ?? 'Remote operation failed');
        if (Date.now() >= current.expiresAt) throw new Error('Remote operation timed out; its outcome may need checking before retry');
        this.validateFile(kind, input, job.userMessageSeq);
        await delay(400, undefined, { signal: controller.signal });
      }
    } finally { this.controllers.delete(controller); }
  }

  private async recordedWrite(job: FileJob): Promise<{ found: boolean; result?: unknown }> {
    const task = this.engine.getForConnection(String(job.input.connectionId), job.taskId);
    const receipt = task.localChanges.find(receipt => receipt.operationId === job.input.operationId && receipt.roundId === job.roundId);
    if (job.status === 'done' && job.result !== undefined) {
      const saved = localReceiptSchema.parse(job.result);
      if (saved.operationId !== job.input.operationId || saved.roundId !== job.roundId || (receipt && canonicalJson(saved) !== canonicalJson(receipt))) throw new Error('Recorded write receipt changed');
      return { found: true, result: saved };
    }
    if (!receipt) { if (job.status === 'done') throw new Error('Recorded write receipt unavailable'); return { found: false }; }
    await this.state.mutate(draft => {
      const current = draft.jobs.find(item => item.id === job.id);
      if (!current || current.hash !== job.hash || current.deviceId !== job.deviceId) throw new Error('Recorded operation identity changed');
      if (current.status === 'done' && current.result !== undefined && canonicalJson(current.result) !== canonicalJson(receipt)) throw new Error('Recorded write receipt changed');
      current.status = 'done'; current.result = receipt; current.error = null;
    });
    return { found: true, result: receipt };
  }

  private hasRecordedWrite(job: FileJob): boolean {
    if (job.status === 'done') return true;
    return this.engine.getForConnection(String(job.input.connectionId), job.taskId).localChanges.some(receipt => receipt.operationId === job.input.operationId && receipt.roundId === job.roundId);
  }
}
