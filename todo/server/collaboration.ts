import { randomUUID } from 'node:crypto';
import { createWebSocketTransportFactory, defaultWebSocketFactory } from '@getpaseo/client/internal/daemon-client-websocket-transport';
import type { DaemonTransport } from '@getpaseo/client/internal/daemon-client-transport-types';
import {
  capabilitiesFrom,
  collaborationStateSchema,
  collaborationWireCommands,
  promptExamples,
  rolePromptsCompatible,
  TASK_COLLABORATION_ISOLATION,
  taskCollaborationSchema,
  unavailableCatalog,
  type CollaborationCapabilities,
  type CollaborationCatalog,
  type CollaborationControlAction,
  type CollaborationState,
  type CollaborationWireCommand,
  type TaskCollaboration,
} from '../shared/collaboration';
import { parseTodoError, todoError } from '../shared/errors';

const ALLOWED = new Set<string>(collaborationWireCommands);
const HANDSHAKE_MS = 8_000;
const COMMAND_MS = 15_000;

export interface CollaborationOpenInput {
  /** Idempotency key. The host binds the conversation to this id, so a repeat open resumes it. */
  requestId: string;
  workspaceId: string;
  agentId?: string;
  goal?: string;
  fresh?: boolean;
  collaboration: TaskCollaboration;
}

export interface OpenedCollaboration {
  conversationId: string;
  runId: string | null;
  agentId: string | null;
  workspaceId: string;
  requestId: string | null;
  mode: TaskCollaboration['mode'] | null;
  isolation: 'local' | 'worktree' | null;
  error: string | null;
  state: CollaborationState;
}

export interface CollaborationPort {
  catalog(): Promise<CollaborationCatalog>;
  open(input: CollaborationOpenInput): Promise<OpenedCollaboration>;
  control(input: { id: string; action: CollaborationControlAction }): Promise<CollaborationState>;
  status(): Promise<CollaborationState>;
}

export interface FramePeer {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

interface PendingCommand {
  resolve: (state: CollaborationState) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Speaks the host's public `collaboration.command.request` frames.
 * SDK 0.10.1 neither sends that command nor delivers its response: its session schema rejects the
 * request, and its socket parser drops the reply before listeners run. This wire keeps its own socket.
 */
export class CollaborationWire {
  private peer: FramePeer | null = null;
  private features: CollaborationCapabilities | null = null;
  private connecting: Promise<CollaborationCapabilities> | null = null;
  private pending = new Map<string, PendingCommand>();
  private inflight = new Map<string, Promise<CollaborationState>>();
  private generation = 0;
  private failHandshake: ((error: Error) => void) | null = null;
  private stopped = false;

  constructor(private readonly options: {
    dial: () => Promise<FramePeer>;
    hello: () => Record<string, unknown>;
    commandTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  }) {}

  async capabilities(): Promise<CollaborationCapabilities> {
    if (this.stopped) throw todoError('collaboration-unavailable', 'collaboration wire closed');
    if (this.features && this.peer) return this.features;
    this.connecting ??= this.handshake().catch(error => {
      this.connecting = null;
      this.detach(true);
      throw error;
    });
    return this.connecting;
  }

  async command(command: CollaborationWireCommand, input: unknown, requestId: string = randomUUID()): Promise<CollaborationState> {
    if (!ALLOWED.has(command)) throw todoError('collaboration-unavailable', `refusing ${command}`);
    const capabilities = await this.capabilities();
    if (!capabilities.collaboration) throw todoError('collaboration-unavailable');
    const existing = this.inflight.get(requestId);
    if (existing) return existing;
    const run = this.send(command, input, requestId).finally(() => this.inflight.delete(requestId));
    this.inflight.set(requestId, run);
    return run;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.rejectAll(todoError('collaboration-unavailable', 'collaboration wire closed'));
    this.failHandshake?.(todoError('collaboration-unavailable', 'collaboration wire closed'));
    this.detach(true);
  }

  private async handshake(): Promise<CollaborationCapabilities> {
    const generation = this.generation;
    const peer = await this.options.dial();
    if (this.stopped || generation !== this.generation) {
      peer.close();
      throw todoError('collaboration-unavailable', 'collaboration wire closed');
    }
    this.peer = peer;
    const timeoutMs = this.options.handshakeTimeoutMs ?? HANDSHAKE_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, features?: CollaborationCapabilities) => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timer);
        this.failHandshake = null;
        if (error) reject(error);
        else if (features) resolve(features);
      };
      this.failHandshake = error => finish(error);
      const timer = setTimeout(() => finish(new Error('collaboration handshake timed out')), timeoutMs);
      peer.onClose(reason => {
        if (generation !== this.generation) return;
        const error = new Error(reason || 'collaboration connection closed');
        this.rejectAll(todoError('collaboration-unavailable', error.message));
        // A live session has to forget the socket. A handshake failure is closed by the caller
        // after `finish` rejects, so a replacement dial cannot be torn down from this callback.
        if (this.features) {
          this.detach(false);
          return;
        }
        finish(error);
      });
      peer.onMessage(data => {
        if (generation !== this.generation) return;
        const features = this.receive(data);
        if (!features) return;
        this.features = features;
        finish(undefined, features);
      });
      try { peer.send(JSON.stringify(this.options.hello())); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private send(command: CollaborationWireCommand, input: unknown, requestId: string): Promise<CollaborationState> {
    const peer = this.peer;
    if (!peer) return Promise.reject(todoError('collaboration-unavailable', 'collaboration connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(todoError('collaboration-unavailable', 'collaboration command timed out'));
      }, this.options.commandTimeoutMs ?? COMMAND_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        peer.send(JSON.stringify({
          type: 'session',
          message: { type: 'collaboration.command.request', requestId, command, input },
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Returns capabilities once `server_info` arrives. Command replies settle their own waiters. */
  private receive(raw: string): CollaborationCapabilities | null {
    let frame: unknown;
    try { frame = JSON.parse(raw); }
    catch { return null; }
    if (!frame || typeof frame !== 'object') return null;
    const envelope = frame as { type?: unknown; reason?: unknown; message?: unknown };
    if (envelope.type === 'hello.rejected') {
      const error = todoError('collaboration-unavailable', typeof envelope.reason === 'string' ? envelope.reason : 'hello rejected');
      this.rejectAll(error);
      this.failHandshake?.(error);
      return null;
    }
    if (envelope.type !== 'session' || !envelope.message || typeof envelope.message !== 'object') return null;
    const message = envelope.message as { type?: unknown; payload?: unknown };
    if (message.type === 'status') {
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return null;
      const status = payload as { status?: unknown; features?: unknown };
      if (status.status !== 'server_info' || this.features) return null;
      const features = status.features && typeof status.features === 'object' ? status.features as Record<string, unknown> : undefined;
      return capabilitiesFrom(features);
    }
    if (message.type !== 'collaboration.command.response' && message.type !== 'rpc_error') return null;
    const payload = message.payload && typeof message.payload === 'object' ? message.payload as { requestId?: unknown; state?: unknown; error?: unknown } : null;
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (message.type === 'rpc_error') {
      pending.reject(todoError('collaboration-unavailable', typeof payload?.error === 'string' ? payload.error : 'collaboration command failed'));
      return null;
    }
    const parsed = collaborationStateSchema.safeParse(payload?.state);
    if (!parsed.success) {
      pending.reject(todoError('collaboration-invalid', parsed.error.issues.map(issue => issue.message).join('; ')));
      return null;
    }
    pending.resolve(parsed.data);
    return null;
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private detach(closePeer: boolean): void {
    this.generation += 1;
    const peer = this.peer;
    this.peer = null;
    this.features = null;
    this.connecting = null;
    if (!closePeer) return;
    try { peer?.close(); } catch { /* the socket may already be gone */ }
  }
}

export class PaseoCollaborationPort implements CollaborationPort {
  constructor(private readonly wire: CollaborationWire) {}

  async catalog(): Promise<CollaborationCatalog> {
    let capabilities = capabilitiesFrom(undefined);
    try {
      capabilities = await this.wire.capabilities();
      if (!capabilities.collaboration) return { capabilities, settings: null, rolePrompts: {}, promptExamples, error: explainUnavailable() };
      const state = await this.wire.command('status', {});
      return { capabilities, settings: state.settings, rolePrompts: state.rolePrompts ?? {}, promptExamples, error: state.error };
    } catch (error) {
      return { capabilities, settings: null, rolePrompts: {}, promptExamples, error: parseTodoError(error) };
    }
  }

  async open(input: CollaborationOpenInput): Promise<OpenedCollaboration> {
    const capabilities = await this.wire.capabilities();
    if (!capabilities.collaboration) throw todoError('collaboration-unavailable');
    if (!capabilities.inlineModels) throw todoError('collaboration-unavailable', '主机不会按任务使用协作设置');
    const parsed = taskCollaborationSchema.safeParse(input.collaboration);
    if (!parsed.success) throw todoError('collaboration-invalid', parsed.error.issues.map(issue => issue.message).join('; '));
    const collaboration = parsed.data;
    if (collaboration.mode === 'execute_review' && !capabilities.executeReview) {
      throw todoError('collaboration-unavailable', '主机不支持执行＋审核');
    }
    if (collaboration.settings.rolePrompts) {
      // The host currently overwrites this field in conversation.open. Check before sending
      // the goal, without changing global settings to make a task-specific prompt appear to work.
      const status = await this.wire.command('status', {});
      if (status.error) throw todoError('collaboration-unavailable', status.error);
      if (!rolePromptsCompatible(collaboration.settings.rolePrompts, status.rolePrompts)) {
        throw todoError('collaboration-prompts-unavailable');
      }
    }
    const state = await this.wire.command('conversation.open', {
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      fresh: input.fresh ?? !input.agentId,
      mode: collaboration.mode,
      isolation: TASK_COLLABORATION_ISOLATION,
      settings: collaboration.settings,
    }, input.requestId);
    const conversation = state.conversations.find(entry => entry.requestId === input.requestId);
    if (!conversation?.agentId) {
      throw todoError('collaboration-unavailable', conversation?.error ?? conversationError(state) ?? '协作会话还没有就绪');
    }
    return {
      conversationId: conversation.id,
      runId: conversation.run?.id ?? null,
      agentId: conversation.agentId ?? null,
      workspaceId: conversation.workspaceId,
      requestId: conversation.requestId ?? null,
      mode: conversation.mode ?? collaboration.mode,
      isolation: conversation.isolation ?? TASK_COLLABORATION_ISOLATION,
      error: conversation.error ?? state.error,
      state,
    };
  }

  async control(input: { id: string; action: CollaborationControlAction }): Promise<CollaborationState> {
    return this.wire.command('run.control', input);
  }

  async status(): Promise<CollaborationState> {
    return this.wire.command('status', {});
  }

  close(): Promise<void> {
    return this.wire.close();
  }
}

export function openCollaborationPort(options: { url: string; password?: string }): PaseoCollaborationPort & { close(): Promise<void> } {
  const password = options.password && options.password.length > 0 ? options.password : undefined;
  const bearer = password && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(password) ? password : null;
  const wire = new CollaborationWire({
    dial: () => dial(options.url, bearer ? [`paseo.bearer.${bearer}`] : undefined),
    hello: () => ({
      type: 'hello',
      clientId: 'paseo-todo-collaboration',
      clientType: 'cli',
      protocolVersion: 1,
      ...(password ? { auth: { kind: 'password', password } } : {}),
      appVersion: '0.10.1',
      capabilities: { hello_rejection: true },
    }),
  });
  return new PaseoCollaborationPort(wire);
}

function explainUnavailable(): string {
  return parseTodoError(todoError('collaboration-unavailable'));
}

function conversationError(state: CollaborationState): string | null {
  return state.error ?? state.conversations.find(entry => entry.error)?.error ?? null;
}

function dial(url: string, protocols: string[] | undefined): Promise<FramePeer> {
  const transport = createWebSocketTransportFactory(defaultWebSocketFactory)({ url, ...(protocols ? { protocols } : {}) });
  return peerFromTransport(transport);
}

function peerFromTransport(transport: DaemonTransport): Promise<FramePeer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
      try { transport.close(); } catch { /* failed sockets may already be closed */ }
    };
    const timer = setTimeout(() => fail(new Error('collaboration socket timed out')), HANDSHAKE_MS);
    const peer: FramePeer = {
      send: data => transport.send(data),
      close: () => transport.close(),
      onMessage: handler => {
        transport.onMessage((data, isBinary) => {
          if (isBinary || typeof data !== 'string') return;
          handler(data);
        });
      },
      onClose: handler => {
        transport.onClose(event => handler(closeReason(event)));
      },
    };
    transport.onOpen(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(peer);
    });
    transport.onError(event => fail(new Error(closeReason(event) || 'collaboration socket failed')));
    transport.onClose(event => fail(new Error(closeReason(event) || 'collaboration socket closed')));
  });
}

function closeReason(event: unknown): string | undefined {
  if (event instanceof Error) return event.message;
  if (typeof event === 'string') return event;
  if (event && typeof event === 'object' && 'reason' in event && typeof event.reason === 'string') return event.reason;
  return undefined;
}

export { unavailableCatalog };
