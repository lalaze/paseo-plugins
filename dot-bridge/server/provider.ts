import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderPrompt, ProviderRegistration, ProviderTimelineItem, ProviderToolCallDetail } from '@getpaseo/plugin/server/provider';
import { attachmentContentSchema, MAX_ATTACHMENT_BYTES, type AttachmentContent } from '../shared/attachments';
import type { LocalReceipt } from '../shared/local-files';
import { currentRound, uuidSchema, type Task } from '../shared/schema';
import type { DotActivity } from './activity';
import { unifiedDiff } from './diff';
import type { BridgeEngine } from './engine';

export const DOT_PROVIDER_ID = 'dot';
export const WORKSPACE_ENV = 'PASEO_DOT_WORKSPACE_ID';
const supported = ['prompt.message', 'prompt.image', 'session.persistence', 'timeline.plugin'];
const bindingSchema = z.object({ taskId: uuidSchema, cwd: z.string(), workspaceId: z.string().min(1), taskCreated: z.boolean().default(false) }).strict();
type Binding = z.infer<typeof bindingSchema>;
/** `changes` lists receipts whose edit cards this session already handled; receipts never change. */
type Session = { id: string; binding: Binding; systemPrompt: string; seen: Map<string, string>; changes: Set<string>; turn: string | null; busy: boolean };

/** Stable across process restarts; a redelivered client message cannot execute twice. */
export function promptOperationId(taskId: string, clientMessageId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify([taskId, clientMessageId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function promptContents(prompt: ProviderPrompt): Promise<{ body: string; attachments: AttachmentContent[] }> {
  if (prompt.input.type !== 'message' || prompt.outputSchema || prompt.delivery === 'steer') throw new Error('Dot currently supports ordinary messages and attachments.');
  const texts: string[] = [], attachments: AttachmentContent[] = [];
  for (const part of prompt.input.content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') attachments.push(attachmentContentSchema.parse({ name: `image-${attachments.length + 1}.${part.mimeType.split('/')[1] || 'bin'}`, mediaType: part.mimeType, encoding: 'base64', content: part.data }));
    else if (part.type === 'uploaded_file') {
      const file = await open(part.path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('Dot attachments must be files of at most 1 MiB.');
        const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_ATTACHMENT_BYTES) throw new Error('Dot attachments must be at most 1 MiB.');
        attachments.push(attachmentContentSchema.parse({ name: part.fileName, mediaType: part.mimeType || 'application/octet-stream', encoding: 'base64', content: buffer.subarray(0, length).toString('base64') }));
      } finally { await file.close(); }
    } else throw new Error(`Dot does not yet support ${part.type} attachments. Paste the relevant text or upload a file.`);
  }
  const body = texts.join('\n\n').trim() || (attachments.length ? 'Please read the attached files and respond.' : '');
  if (!body || body.length > 20_000) throw new Error('Dot messages must contain 1–20,000 characters.');
  return { body, attachments };
}

function waitingForDot(task: Task): boolean {
  const round = currentRound(task);
  return ['queued', 'dispatched', 'claimed', 'running'].includes(task.status)
    || (task.status === 'waiting_user' && round.processedThroughSeq < task.userMessageSeq)
    || (task.status === 'completed' && !round.result?.coversLatest);
}

/** One card per Bridge call Dot made, so the conversation shows work as it happens. */
function activityCard(task: Task, entry: DotActivity): ProviderTimelineItem {
  // An upload Dot abandoned stops spinning once its round no longer waits for Dot.
  const status = entry.status === 'running' && (entry.roundId !== task.currentRoundId || currentRound(task).stop.requested || !waitingForDot(task)) ? 'canceled' : entry.status;
  const card = (name: string, detail: ProviderToolCallDetail): ProviderTimelineItem => status === 'failed'
    ? { type: 'tool_call', id: entry.id, callId: entry.id, name, detail, status, error: entry.detail || '失败' }
    : { type: 'tool_call', id: entry.id, callId: entry.id, name, detail, status, error: null };
  switch (entry.kind) {
    case 'read-task': return card('Dot', { type: 'plain_text', label: '已读取你的消息', icon: 'eye' });
    case 'list': return card('List', { type: 'plain_text', label: entry.target, ...(status === 'failed' ? {} : { text: entry.detail }), icon: 'search' });
    case 'read': return card('Read', { type: 'read', filePath: entry.target });
    case 'read-attachment': return card('Dot', { type: 'plain_text', label: `读取附件 ${entry.target}${entry.detail ? `（${entry.detail}）` : ''}`, icon: 'eye' });
    case 'upload': return card('Dot', { type: 'plain_text', label: { running: `正在接收 ${entry.target}（${entry.detail}）`, completed: `已接收 ${entry.target}`, canceled: `未接收完 ${entry.target}（${entry.detail}）`, failed: `接收 ${entry.target} 失败` }[status], icon: 'bot' });
    case 'apply-failed': return card('Dot', { type: 'plain_text', label: `修改未应用：${entry.target}`, icon: 'pencil' });
  }
}

export function createDotProvider(options: { engine(): Promise<BridgeEngine>; tick(): Promise<void>; signal: AbortSignal; pollMs?: number }): ProviderRegistration {
  return {
    id: DOT_PROVIDER_ID, label: 'Dot', description: 'Chat with your connected Dot through Dot Bridge.',
    async connect(request): Promise<ProviderConnection> {
      if (!request.versions.includes(1)) throw new Error('Dot requires provider protocol version 1.');
      const capabilities = supported.filter(value => request.capabilities.includes(value));
      const engine = await options.engine();
      const sessions = new Map<string, Session>(), listeners = new Set<(event: ProviderEvent) => void>();
      let closed = false;
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      const item = (session: Session, value: ProviderTimelineItem, at?: number, skip = false) => {
        const hash = JSON.stringify(value);
        if (session.seen.get(value.id) === hash) return;
        session.seen.set(value.id, hash);
        if (!skip) emit({ type: 'timeline.item', sessionId: session.id, item: value, ...(at ? { timestamp: new Date(at).toISOString() } : {}) });
      };
      const finish = (session: Session, state: 'completed' | 'failed' | 'canceled', message?: string) => {
        if (!session.turn) return;
        emit({ type: 'session.turn', sessionId: session.id, turnId: session.turn, state, ...(message ? { error: { message } } : {}) });
        session.turn = null;
      };
      /** Applied files as edit cards with diffs from the operation journal, replacing the plain note. */
      const changeCards = (task: Task, receipt: LocalReceipt): ProviderTimelineItem[] => {
        const contents = engine.changeContents(receipt.operationId);
        const cards: ProviderTimelineItem[] = receipt.files.map((file, index) => {
          const id = `${task.id}:change:${receipt.operationId}:${index}`;
          const change = contents?.changes.find(entry => entry.path === file.path);
          const before = file.action === 'create' ? '' : contents?.before.find(entry => entry.path === file.path)?.content;
          const diff = change && typeof before === 'string' ? unifiedDiff(before, change.content ?? '') : null;
          return { type: 'tool_call', id, callId: id, name: 'Edit', detail: { type: 'edit', filePath: file.path, ...(diff ? { unifiedDiff: diff } : {}) }, status: 'completed', error: null };
        });
        if (receipt.conflicts.length) {
          const id = `${task.id}:change:${receipt.operationId}:conflicts`;
          cards.push({ type: 'tool_call', id, callId: id, name: 'Dot', detail: { type: 'plain_text', label: receipt.status === 'partial' ? '部分修改未应用' : '修改未应用', icon: 'pencil' }, status: 'failed', error: receipt.conflicts.join('\n') });
        }
        return cards;
      };
      const refresh = (session: Session, task: Task, skip = false) => {
        const activity = engine.activity.list(task.id);
        for (const round of task.rounds) {
          // A round replays in time order, as it happened live; equal times keep this order.
          const entries: Array<[number, ProviderTimelineItem]> = [], built: string[] = [];
          for (const message of task.messages.filter(message => message.roundId === round.roundId)) {
            const clientMessageId = task.provider?.clientMessageIds[String(message.seq)];
            const receipt = message.author === 'dot' ? task.localChanges.find(change => change.operationId === message.updateId) : undefined;
            if (message.author === 'user' && clientMessageId) entries.push([message.at, { type: 'user_message', id: `${task.id}:m:${message.seq}`, text: message.body, clientMessageId }]);
            else if (receipt) {
              // Journal reads and diffs happen once per session, not on every poll.
              if (!session.changes.has(receipt.operationId)) for (const card of changeCards(task, receipt)) entries.push([message.at, card]);
              built.push(receipt.operationId);
            } else if (message.author === 'dot' && !task.attachments.some(attachment => attachment.id === message.updateId)) entries.push([message.at, message.kind === 'result' || message.kind === 'question' || message.kind === 'progress'
              ? { type: 'assistant_message', id: `${task.id}:m:${message.seq}`, text: message.body }
              : { type: 'notification', id: `${task.id}:m:${message.seq}`, level: message.kind === 'error' ? 'error' : 'info', message: message.body }]);
          }
          for (const result of [...round.resultHistory.map(record => record.result), ...(round.result ? [round.result] : [])]) {
            entries.push([result.reportedAt, { type: 'assistant_message', id: `${task.id}:result:${result.updateId}`, text: result.summary }]);
          }
          for (const attachment of task.attachments.filter(attachment => attachment.roundId === round.roundId)) {
            if (capabilities.includes('timeline.plugin')) entries.push([attachment.createdAt, { type: 'plugin', id: `attachment:${attachment.id}`, pluginId: 'paseo-dot-bridge', kind: 'dot-attachment', version: 1, data: { taskId: task.id, attachment } }]);
          }
          for (const entry of activity) if (entry.roundId === round.roundId) entries.push([entry.at, activityCard(task, entry)]);
          for (const [at, value] of entries.sort((left, right) => left[0] - right[0])) item(session, value, at, skip);
          for (const operationId of built) session.changes.add(operationId);
        }
        const round = currentRound(task);
        const label = round.stop.requested && !['stopped', 'completed', 'failed'].includes(task.status)
          ? '已请求 Dot 停止，等待远端确认。'
          : ({ queued: engine.readyToDispatch() ? '等待发送给 Dot。' : '等待 Dot Bridge 连接就绪；请在插件中检查连接。', dispatched: '已发送，等待 Dot 接单。', claimed: 'Dot 已接单。', running: 'Dot 正在处理。', waiting_user: 'Dot 等待你的回复。', completed: round.result?.coversLatest ? 'Dot 已完成。' : 'Dot 的回复尚未覆盖最新消息，等待补充回复。', failed: 'Dot 处理失败，可发消息重试。', stopped: 'Dot 已停止。' }[task.status]);
        const statusId = `${task.id}:status:${task.currentRoundId}:${task.userMessageSeq}`;
        const progress = task.status === 'running' && !round.stop.requested && round.lastProgress?.kind === 'running'
          && round.lastProgress.processedThroughSeq >= task.userMessageSeq ? round.lastProgress.note.trim() : '';
        const progressLabel = progress.replace(/\s+/g, ' ');
        const detail = { type: 'plain_text' as const, label: progressLabel ? (progressLabel.length > 100 ? `${progressLabel.slice(0, 100)}…` : progressLabel) : label, text: progress || label, icon: 'bot' as const };
        item(session, task.status === 'failed'
          ? { type: 'tool_call', id: statusId, callId: statusId, name: 'Dot', detail, status: 'failed', error: round.lastProgress?.note || label }
          : { type: 'tool_call', id: statusId, callId: statusId, name: 'Dot', detail, status: task.status === 'stopped' ? 'canceled' : waitingForDot(task) ? 'running' : 'completed', error: null }, undefined, skip);
        if (task.status === 'waiting_user' && round.processedThroughSeq >= task.userMessageSeq) finish(session, 'completed');
        else if (task.status === 'completed' && round.result?.coversLatest) finish(session, 'completed');
        else if (task.status === 'failed') finish(session, 'failed', round.lastProgress?.note || 'Dot failed');
        else if (task.status === 'stopped') finish(session, 'canceled');
      };
      const timer = setInterval(() => {
        for (const session of sessions.values()) {
          if (session.busy) continue;
          const task = engine.tasks().find(task => task.id === session.binding.taskId);
          if (task) refresh(session, task);
        }
      }, options.pollMs ?? 750);
      timer.unref();
      const close = async () => { closed = true; clearInterval(timer); sessions.clear(); listeners.clear(); options.signal.removeEventListener('abort', abort); };
      const abort = () => { void close(); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) await close();
      let queue = Promise.resolve();
      const connection: ProviderConnection = {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        close,
        async send(input: ProviderInput) {
          if (closed) throw new Error('Dot provider connection is closed');
          try {
            if (input.type === 'catalog') {
              emit({ type: 'catalog', requestId: input.requestId, catalog: { models: [{ id: 'dot', label: 'Connected Dot' }], modes: [], defaultModel: 'dot' } });
              return;
            }
            if (input.type === 'session.open') {
              if (sessions.has(input.sessionId)) throw new Error('Dot session is already open');
              if (input.persistence && input.persistence.version !== 1) throw new Error('Unsupported Dot session version');
              const binding = input.persistence ? bindingSchema.parse(input.persistence.data) : bindingSchema.parse({ taskId: randomUUID(), cwd: input.config.cwd, workspaceId: input.config.env[WORKSPACE_ENV] });
              if (binding.cwd !== input.config.cwd || (input.config.env[WORKSPACE_ENV] && binding.workspaceId !== input.config.env[WORKSPACE_ENV])) throw new Error('Dot session workspace mismatch');
              const task = engine.tasks().find(task => task.id === binding.taskId);
              if (binding.taskCreated && !task) throw new Error('The saved Dot task is missing; restore the Bridge data before continuing.');
              if (task && (task.provider?.cwd !== binding.cwd || task.workspaceId !== binding.workspaceId)) throw new Error('Dot task binding mismatch');
              const session: Session = { id: input.sessionId, binding, systemPrompt: input.config.systemPrompt ?? '', seen: new Map(), changes: new Set(), turn: null, busy: false };
              sessions.set(session.id, session);
              emit({ type: 'session.opened', requestId: input.requestId, sessionId: session.id, capabilities, restoration: 'core', persistence: { version: 1, data: binding }, cwd: binding.cwd });
              if (task) refresh(session, task, input.history === 'skip');
              emit({ type: 'session.ready', requestId: input.requestId, sessionId: session.id });
              if (task && waitingForDot(task) && !currentRound(task).stop.requested) {
                session.turn = `${task.currentRoundId}:${task.userMessageSeq}`;
                emit({ type: 'session.turn', sessionId: session.id, turnId: session.turn, state: 'started' });
              }
              return;
            }
            if (!('sessionId' in input)) throw new Error(`Unsupported Dot request: ${input.type}`);
            const session = sessions.get(input.sessionId);
            if (!session) throw new Error('Dot session is not open');
            if (input.type === 'session.prompt') {
              if (session.busy || session.turn) throw new Error('Dot is still handling the previous message');
              session.busy = true;
              try {
                const content = await promptContents(input.prompt);
                if (session.systemPrompt.length > 20_000) throw new Error('Dot system instructions exceed 20,000 characters');
                const outcome = await engine.providerPrompt({ id: session.binding.taskId, cwd: session.binding.cwd, workspaceId: session.binding.workspaceId,
                  operationId: promptOperationId(session.binding.taskId, input.prompt.clientMessageId), clientMessageId: input.prompt.clientMessageId,
                  ...content, systemPrompt: session.systemPrompt });
                const task = engine.task(session.binding.taskId);
                if (outcome.duplicate) {
                  emit({ type: 'session.prompt_result', sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: 'completed' } });
                  refresh(session, task);
                  return;
                }
                session.binding.taskCreated = true;
                emit({ type: 'session.persistence', sessionId: session.id, persistence: { version: 1, data: session.binding } });
                session.turn = `${task.currentRoundId}:${task.userMessageSeq}`;
                emit({ type: 'session.prompt_result', sessionId: session.id, clientMessageId: input.prompt.clientMessageId, result: { type: 'turn', turnId: session.turn } });
                emit({ type: 'session.turn', sessionId: session.id, turnId: session.turn, state: 'started' });
                refresh(session, task);
                void options.tick();
              } finally { session.busy = false; }
              return;
            }
            if (input.type === 'session.interrupt') {
              const task = engine.tasks().find(task => task.id === session.binding.taskId);
              if (task && ['queued', 'dispatched', 'claimed', 'running', 'waiting_user'].includes(task.status)) {
                const stopped = await engine.cancelRequest({ id: task.id, revision: task.revision, operationId: randomUUID() });
                refresh(session, stopped);
                void options.tick();
              }
              finish(session, 'canceled', 'Stop requested; dispatched work stops only when Dot acknowledges.');
              emit({ type: 'request.completed', requestId: input.requestId });
              return;
            }
            if (input.type === 'session.close') {
              sessions.delete(session.id);
              emit({ type: 'session.closed', sessionId: session.id });
              emit({ type: 'request.completed', requestId: input.requestId });
              return;
            }
            throw new Error(`Unsupported Dot request: ${input.type}`);
          } catch (error) {
            const failure = { message: error instanceof Error ? error.message : String(error) };
            if (input.type === 'session.prompt') emit({ type: 'session.prompt_result', sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: failure } });
            else if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: failure });
            else throw error;
          }
        },
      };
      const send = connection.send.bind(connection);
      connection.send = input => {
        const pending = queue.then(() => send(input));
        queue = pending.catch(() => undefined);
        return pending;
      };
      return connection;
    },
  };
}
