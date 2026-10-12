import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AttachmentStore, decodeAttachment } from './attachments';
import { clearTransfer, decodeChunk, receiveChunk, saveDeliveredFile } from './attachment-transfers';
import { ActivityLog } from './activity';
import { applyLocalChanges, listSources, readChangeJournal, readSource } from './local-files';
import type { LocalChange, LocalReceipt } from '../shared/local-files';
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENTS, type Attachment, type AttachmentContent, type AttachmentChunk } from '../shared/attachments';
import { dotBridgeError } from '../shared/errors';
import {
  CALLBACK_ENDPOINT_ERROR,
  canonicalJson,
  connectionInstructions,
  eventArgumentsSchema,
  isValidWebhookSecret,
  MAX_EVENT_BYTES,
  taskChangedDataSchema,
  type McpEventType,
  type SubscribeInput,
  type ToolName,
  type UnsubscribeInput,
} from '../shared/mcp';
import {
  appendUserMessage,
  appendDotMessage,
  claimRound,
  createNextRound,
  createTask,
  currentRound,
  dispatchOrder,
  inFlightCount,
  markDelivery,
  markDispatchBlocked,
  markVerification,
  recomputeCoverage,
  reduceProgress,
  reduceResult,
  recordOperation,
  requestCancel,
  retryRound as retryRoundState,
  withDispatch,
} from '../shared/machine';
import {
  connectionSchema,
  emptyVerification,
  resultSchema,
  type Connection,
  type PendingEvent,
  type RemoteStatus,
  type RoundResult,
  type StoreFile,
  type Subscription,
  type Task,
  type Verification,
  type VerifyStatus,
} from '../shared/schema';
import type { GitPort } from './git';
import { checkCallbackUrl, postSigned, type FetchLike, type Lookup } from './http';
import { signPayloadMulti } from './signing';
import type { BridgeStore } from './store';
import { DOT_CONFIRMATION_URL, permissionCurrent, permissionDescription, permissionIntentSchema, pendingPermissions, type DotPermission, type PermissionIntent } from '../shared/permissions';

const CHALLENGE_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const RETRY_BASE = 2000;
const RETRY_MAX = 5 * 60 * 1000;
const PRUNE_AFTER = 7 * 24 * 60 * 60 * 1000;
/** A subscription without an explicit ttl lives for a day; the dot is expected to refresh. */
const DEFAULT_SUBSCRIPTION_TTL = 24 * 60 * 60 * 1000;
/** The previous signing secret is only accepted for this window after a rotation. */
const ROTATION_WINDOW = 24 * 60 * 60 * 1000;
/** A queued task whose base was just found unreachable is not re-probed until this much time passes. */
const RECHECK_MS = 30_000;
/** A callback URL that already passed verification is trusted for this long before re-checking. */
const VERIFY_CACHE_TTL = 24 * 60 * 60 * 1000;
/** Bound the in-memory verification cache so it cannot grow without limit. */
const MAX_VERIFY_CACHE = 32;

export interface EngineDeps {
  store: BridgeStore;
  /** Optional legacy-history test adapter. Installed plugin does not enable Git delivery. */
  git?: GitPort;
  now?: () => number;
  fetchImpl?: FetchLike;
  lookup?: Lookup;
  getMaxInFlight: () => number;
  /** Tests point callbacks at a local server; production validates HTTPS callback addresses. */
  allowPrivateCallback?: boolean;
  randomId?: () => string;
  isBridgeListening?: () => boolean;
  /** An external lifecycle signal; when it aborts, in-flight callbacks and git runs are cancelled. */
  signal?: AbortSignal;
}

export interface TaskSummary {
  mode: Task['mode'];
  taskId: string;
  title: string;
  branch: string | null;
  status: RemoteStatus;
  roundId: string;
  messageSeq: number;
  userMessageSeq: number;
  processedThroughSeq: number;
  claimable: boolean;
  stopRequested: boolean;
  /** Why a queued round is not dispatched yet, e.g. its base commit is unreachable. */
  waitingReason: string | null;
  verificationStatus: VerifyStatus;
  createdAt: number;
}

export interface ResultOutcome {
  accepted: boolean;
  coversLatest: boolean;
  duplicate: boolean;
  reason: 'ok' | 'duplicate' | 'stale-round';
  verification: Verification;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function backoff(attempts: number): number {
  return Math.min(RETRY_MAX, RETRY_BASE * 2 ** Math.max(0, attempts - 1));
}

/** Deterministic subscription id from the event name, canonical arguments and callback URL. */
function subscriptionIdFor(name: string, args: unknown, url: string): string {
  return createHash('sha256').update(`${name}\n${canonicalJson(args)}\n${url}`).digest('hex').slice(0, 32);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The bridge engine owns the queue, the round lifecycle, event delivery and Git verification.
 * Every task change and its pending event are written through a single `store.mutate`, so a saved
 * task can never lose the notification that announces it. Replayed operation ids return the stored
 * result instead of applying the change twice.
 */
export class BridgeEngine {
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly randomId: () => string;
  private readonly abort = new AbortController();
  private bridgeListening = false;
  private secrets: Record<string, string> = {};
  private delivering = false;
  /** Bounded cache of callback URLs that already echoed a challenge, keyed by subject + URL. */
  private readonly verificationCache = new Map<string, { secretHash: string; at: number }>();
  /** In-flight result refreshes, so two calls with the same operationId share one Git run. */
  private readonly refreshing = new Map<string, Promise<Task>>();
  /**
   * In-flight result submissions, keyed by updateId. A duplicate that arrives while the first
   * submission is still verifying shares that completion, so both callers see the same final
   * outcome instead of one reading a half-finished record.
   */
  private readonly processing = new Map<string, Promise<ResultOutcome>>();
  /** What Dot did through the Bridge, for the live native conversation. In memory only. */
  readonly activity = new ActivityLog();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetchImpl;
    this.randomId = deps.randomId ?? (() => randomUUID());
    // The plugin's lifecycle signal is chained into our own, so unload aborts callbacks at once.
    if (deps.signal) {
      if (deps.signal.aborted) this.abort.abort();
      else deps.signal.addEventListener('abort', () => this.abort.abort(), { once: true });
    }
  }

  async init(): Promise<void> {
    this.secrets = await this.deps.store.readSecrets();
    let changed = false;
    if (!this.secrets.mcpToken) {
      this.secrets.mcpToken = randomBytes(32).toString('hex');
      changed = true;
    }
    if (changed) await this.deps.store.writeSecrets(this.secrets);
    await this.deps.store.mutate(draft => {
      if (!draft.connection) draft.connection = this.newConnection();
    });
  }

  dispose(): void {
    this.abort.abort();
  }

  setBridgeListening(flag: boolean): void {
    this.bridgeListening = flag;
  }

  mcpToken(): string {
    return this.secrets.mcpToken ?? '';
  }

  private newConnection(): Connection {
    return connectionSchema.parse({ id: randomBytes(16).toString('hex'), name: 'My dot', challenge: null });
  }

  connection(): Connection {
    const state = this.deps.store.read();
    if (!state.connection) throw dotBridgeError('connection-missing');
    return state.connection;
  }

  tasks(): Task[] {
    return this.deps.store.read().tasks;
  }

  task(id: string): Task {
    const task = this.deps.store.read().tasks.find(item => item.id === id);
    if (!task) throw dotBridgeError('task-missing');
    return task;
  }

  private requireActiveDelivery(task: Task): void {
    if (task.mode === 'git' && !this.deps.git) throw dotBridgeError('task-rejected', 'Historical Git delivery is read-only. Start a local workspace conversation.');
  }

  private localTask(input: { connectionId: string; taskId: string; roundId: string }, task = this.task(input.taskId)): Task {
    if (this.abort.signal.aborted) throw dotBridgeError('task-rejected', 'Bridge is shutting down');
    if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
    if (task.mode !== 'text' || !task.workspaceRoot) throw dotBridgeError('task-rejected', 'Local workspace access is not bound. Send a new message from Paseo.');
    if (task.currentRoundId !== input.roundId) throw dotBridgeError('round-stale');
    const round = currentRound(task);
    if (!round.claim || round.stop.requested || !['claimed', 'running', 'waiting_user'].includes(task.status)) throw dotBridgeError('claim-required', 'Local tools require a claimed active round without a stop request');
    return task;
  }

  listLocalFiles(input: { connectionId: string; taskId: string; roundId: string; directory: string; offset: number }) {
    const task = this.localTask(input);
    return { ...listSources(task.workspaceRoot!, input.directory, input.offset), userMessageSeq: task.userMessageSeq };
  }

  readLocalFile(input: { connectionId: string; taskId: string; roundId: string; path: string }) {
    const task = this.localTask(input);
    const { mode: _mode, ...file } = readSource(task.workspaceRoot!, input.path);
    return { ...file, userMessageSeq: task.userMessageSeq };
  }

  async applyLocalFiles(input: { connectionId: string; taskId: string; roundId: string; operationId: string; userMessageSeq: number; changes: LocalChange[] }): Promise<LocalReceipt> {
    // store.mutate serializes all tasks, cancellation and prompt changes. File preflight and writes
    // are synchronous inside it, so another Bridge operation cannot interleave with the writes.
    return this.deps.store.mutate(draft => {
      const task = this.requireTask(draft, input.taskId);
      if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
      const hash = stableHash({ kind: 'local-files', ...input });
      const prior = draft.dedup.operations[input.operationId];
      if (prior) {
        if (prior.hash !== hash || !prior.receipt) throw dotBridgeError('duplicate-mismatch');
        return JSON.parse(prior.receipt) as LocalReceipt;
      }
      this.localTask(input, task);
      this.assertPermissionMutation(task, 'apply_dot_changes', input.changes.map(change => change.path));
      if (input.userMessageSeq !== task.userMessageSeq) throw dotBridgeError('revision-conflict', 'A newer user message arrived; read the task again before editing files');
      const receipt = applyLocalChanges({ ...input, dataDir: this.deps.store.dir, root: task.workspaceRoot!, at: this.now() });
      const note = receipt.status === 'applied'
        ? `已应用到本地工作区：\n${receipt.files.map(file => `${file.action}: ${file.path}`).join('\n')}`
        : `本地修改${receipt.status === 'partial' ? '仅部分应用' : '未应用'}。\n${receipt.files.map(file => `已应用 ${file.action}: ${file.path}`).join('\n')}\n${receipt.conflicts.join('\n')}`;
      const next = appendDotMessage(task, task.currentRoundId, 'progress', note.slice(0, 20_000), receipt.at, input.operationId);
      next.localChanges.push(receipt);
      this.replace(draft, next);
      draft.dedup.operations[input.operationId] = { hash, taskId: task.id, receipt: JSON.stringify(receipt), replayable: true, at: this.now() };
      return receipt;
    });
  }

  /** Original and requested contents of a local change, for its edit cards. */
  changeContents(operationId: string) {
    return readChangeJournal(this.deps.store.dir, operationId);
  }

  private activeSubscriptions(connection: Connection): Subscription[] {
    const at = this.now();
    return connection.subscriptions.filter(sub => sub.expiresAt === null || sub.expiresAt > at);
  }

  /**
   * Dispatch requires the local bridge to be listening, an active callback-verified
   * `task_changed` route for this connection, and a dot confirmation. A subscription to any other
   * event (e.g. only `connection_test`) is not enough to dispatch real work.
   */
  readyToDispatch(): boolean {
    if (!this.bridgeListening) return false;
    const connection = this.deps.store.read().connection;
    if (!connection) return false;
    const route = this.activeSubscriptions(connection)
      .some(sub => sub.name === 'paseo.dot.task_changed' && sub.verifiedAt !== null);
    return route && connection.dotVerifiedAt !== null;
  }

  connectionFacts(): {
    localBridge: boolean;
    subscribed: boolean;
    callbackVerified: boolean;
    dotVerified: boolean;
    taskRoute: boolean;
    ready: boolean;
    lastCallbackAt: number | null;
  } {
    const connection = this.connection();
    const active = this.activeSubscriptions(connection);
    const taskRoute = active.some(sub => sub.name === 'paseo.dot.task_changed' && sub.verifiedAt !== null);
    return {
      localBridge: this.bridgeListening,
      subscribed: active.length > 0,
      callbackVerified: active.some(sub => sub.verifiedAt !== null),
      dotVerified: connection.dotVerifiedAt !== null,
      taskRoute,
      ready: this.readyToDispatch(),
      lastCallbackAt: connection.lastCallbackAt,
    };
  }

  instructions(): string {
    const connection = this.connection();
    return connectionInstructions(connection.id, connection.callbackBaseUrl);
  }

  /** True only when this exact event reached a callback with 2xx; a stale flag is not enough. */
  eventDelivered(eventId: string): boolean {
    return this.deps.store.read().events.some(event => event.eventId === eventId && event.status === 'delivered');
  }

  /**
   * The connection record is the single source of truth for the display name and the tunnel base
   * URL. Host settings no longer mirror them, so a reload can never overwrite a saved connection.
   * The `revision` guards against a stale client, and an empty string is an explicit clear.
   */
  async configureConnection(input: { operationId: string; revision: number; name: string; publicBaseUrl: string }): Promise<Connection> {
    return this.deps.store.mutate(draft => {
      const content = { kind: 'configure', revision: input.revision, name: input.name, publicBaseUrl: input.publicBaseUrl };
      const dedup = this.dedupOperation(draft, input.operationId, content, null);
      if (dedup.status === 'duplicate') return this.replay<Connection>(draft, input.operationId, draft.connection ?? this.newConnection());
      const connection = draft.connection ?? this.newConnection();
      if (connection.revision !== input.revision) throw dotBridgeError('revision-conflict', `expected ${connection.revision}, got ${input.revision}`);
      connection.name = input.name;
      connection.callbackBaseUrl = input.publicBaseUrl;
      connection.revision += 1;
      draft.connection = connection;
      const response = structuredClone(connection);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  /** Validates a subscription, verifies the callback endpoint, then stores it by deterministic id. */
  async setSubscription(input: SubscribeInput): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: boolean }> {
    const connection = this.connection();
    const args = eventArgumentsSchema(input.name).parse(input.arguments);
    if (args.connectionId !== connection.id) throw dotBridgeError('connection-invalid', 'arguments.connectionId');
    const secret = input.delivery.secret ?? '';
    if (!isValidWebhookSecret(secret)) throw dotBridgeError('connection-invalid', 'delivery.secret must be a whsec_ value of 24-64 bytes');
    let address: string | undefined;
    if (!this.deps.allowPrivateCallback) {
      const check = await checkCallbackUrl(input.delivery.url, this.deps.lookup, this.abort.signal);
      if (!check.ok) throw dotBridgeError('callback-invalid', check.reason);
      address = check.address;
    }
    const id = subscriptionIdFor(input.name, args, input.delivery.url);
    const at = this.now();
    // Re-verifying the callback on every refresh would spam the endpoint with challenges. Cache the
    // successful verification per (subject, callback URL) and re-run it only when the URL or the
    // signing secret changes, bounded by count and a TTL.
    const cacheKey = `${connection.id}\n${input.delivery.url}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const cached = this.verificationCache.get(cacheKey);
    const trusted = cached !== undefined && cached.secretHash === secretHash && at - cached.at < VERIFY_CACHE_TTL;
    if (!trusted) {
      const verified = await this.verifyCallbackEndpoint(input.delivery.url, secret, id, address);
      if (!verified.ok) {
        // Official CallbackEndpointError: the subscribe call fails with -32015.
        const error = dotBridgeError('callback-verification-failed', verified.reason) as Error & { rpcCode?: number; reason?: string };
        error.rpcCode = CALLBACK_ENDPOINT_ERROR;
        error.reason = verified.reason;
        throw error;
      }
      this.rememberVerification(cacheKey, secretHash, at);
    }
    const ttl = input.ttlMs != null && input.ttlMs > 0 ? input.ttlMs : DEFAULT_SUBSCRIPTION_TTL;
    const expiresAt = at + ttl;
    // Per the events contract, refreshBefore is the actual granted expiry, so a client that refreshes
    // at that instant never sees delivery stop before the deadline it was told about.
    const refreshBefore = new Date(expiresAt).toISOString();
    // Keep the previous secret for a bounded rotation window so signatures in flight still validate.
    const previous = this.secrets[`sub:${id}`];
    if (previous && previous !== secret) {
      this.secrets[`sub:${id}:prev`] = previous;
      this.secrets[`sub:${id}:prevUntil`] = String(at + ROTATION_WINDOW);
    }
    this.secrets[`sub:${id}`] = secret;
    await this.deps.store.writeSecrets(this.secrets);
    await this.deps.store.mutate(draft => {
      const current = draft.connection ?? this.newConnection();
      const existing = current.subscriptions.find(sub => sub.id === id);
      if (existing) {
        existing.url = input.delivery.url;
        existing.arguments = args;
        existing.expiresAt = expiresAt;
        existing.cursor = null;
        existing.verifiedAt = at;
        existing.updatedAt = at;
      } else {
        current.subscriptions.push({
          id,
          name: input.name,
          arguments: args,
          url: input.delivery.url,
          expiresAt,
          cursor: null,
          verifiedAt: at,
          createdAt: at,
          updatedAt: at,
        });
      }
      current.callbackVerifications[id] = at;
      draft.connection = current;
      for (const task of draft.tasks) this.wake(draft, task);
    });
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  /** Bounds the verification cache by count and TTL; the oldest entry is dropped past the cap. */
  private rememberVerification(key: string, secretHash: string, at: number): void {
    this.verificationCache.delete(key);
    this.verificationCache.set(key, { secretHash, at });
    while (this.verificationCache.size > MAX_VERIFY_CACHE) {
      const oldest = this.verificationCache.keys().next().value;
      if (oldest === undefined) break;
      this.verificationCache.delete(oldest);
    }
  }

  /** Unsubscribe by the original subscription identity (name, arguments, callback URL). */
  async unsubscribe(input: UnsubscribeInput): Promise<void> {
    const args = eventArgumentsSchema(input.name).parse(input.arguments);
    const id = subscriptionIdFor(input.name, args, input.delivery.url);
    const connectionId = this.deps.store.read().connection?.id;
    if (connectionId) this.verificationCache.delete(`${connectionId}\n${input.delivery.url}`);
    await this.deps.store.mutate(draft => {
      const connection = draft.connection;
      if (!connection) return;
      connection.subscriptions = connection.subscriptions.filter(sub => sub.id !== id);
      delete connection.callbackVerifications[id];
      draft.connection = connection;
    });
    delete this.secrets[`sub:${id}`];
    delete this.secrets[`sub:${id}:prev`];
    delete this.secrets[`sub:${id}:prevUntil`];
    await this.deps.store.writeSecrets(this.secrets);
  }

  /** Posts a signed `{type:"verification", challenge}` and requires a 2xx echo of the challenge. */
  private async verifyCallbackEndpoint(url: string, secret: string, subscriptionId: string, address?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const challenge = randomBytes(24).toString('hex');
    const payload = JSON.stringify({ type: 'verification', challenge });
    const id = this.randomId();
    const timestamp = String(Math.floor(this.now() / 1000));
    const signature = signPayloadMulti([secret], id, timestamp, payload);
    const response = await postSigned(
      url,
      payload,
      {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'X-MCP-Subscription-Id': subscriptionId,
      },
      this.fetchImpl,
      this.abort.signal,
      address,
    );
    if (response.error) return { ok: false, reason: 'timeout' };
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: 'challenge_failed' };
    let echoed = '';
    try {
      const parsed = JSON.parse(response.text) as { challenge?: unknown };
      if (typeof parsed.challenge === 'string') echoed = parsed.challenge;
    } catch {
      echoed = '';
    }
    if (!echoed || !constantTimeEqual(echoed, challenge)) return { ok: false, reason: 'challenge_failed' };
    return { ok: true };
  }

  async startConnectionTest(operationId: string): Promise<{ challenge: string; expiresAt: number; eventId: string }> {
    const content = { kind: 'connection-test' };
    return this.deps.store.mutate(draft => {
      // One challenge and one event per operationId, recorded in the operation log so a replay after
      // another test (A/B/A) still returns A's original challenge instead of minting a new one.
      const existing = draft.dedup.operations[operationId];
      if (existing) {
        if (existing.hash !== stableHash(content)) throw dotBridgeError('duplicate-mismatch', 'operationId');
        const receipt = this.readReceipt<{ challenge: string; expiresAt: number; eventId: string }>(existing.receipt);
        if (receipt) return receipt;
        throw dotBridgeError('operation-archived', operationId);
      }
      const connection = draft.connection ?? this.newConnection();
      const challenge = randomBytes(24).toString('hex');
      const expiresAt = this.now() + CHALLENGE_TTL;
      connection.challenge = { value: challenge, expiresAt, used: false, operationId };
      draft.connection = connection;
      const eventId = this.emit(draft, 'paseo.dot.connection_test', connection.id, { challenge, expiresAt });
      const result = { challenge, expiresAt, eventId };
      this.dedupOperation(draft, operationId, content, null);
      this.setReceipt(draft, operationId, result);
      return result;
    });
  }

  async confirmConnection(connectionId: string, challenge: string): Promise<{ confirmed: boolean }> {
    const connection = this.connection();
    if (connection.id !== connectionId) throw dotBridgeError('connection-invalid');
    const pending = connection.challenge;
    if (!pending) throw dotBridgeError('challenge-missing');
    if (pending.used || pending.expiresAt < this.now() || pending.value !== challenge) throw dotBridgeError('challenge-expired');
    await this.deps.store.mutate(draft => {
      const current = draft.connection;
      if (!current || !current.challenge || current.challenge.value !== challenge || current.challenge.used) {
        throw dotBridgeError('challenge-expired');
      }
      current.challenge.used = true;
      current.dotVerifiedAt = this.now();
      draft.connection = current;
    });
    return { confirmed: true };
  }

  async createTask(input: {
    operationId: string;
    workspaceId: string;
    title: string;
    requirement: string;
    acceptance: string;
    mode?: 'git' | 'text';
    repository: string | null;
    remoteName: string | null;
    baseSha: string | null;
    targetBranch: string | null;
    environmentHint: string;
    workspaceRoot?: string;
  }): Promise<Task> {
    if (input.mode !== 'text' && !this.deps.git) throw dotBridgeError('task-rejected', 'Git delivery has been removed. Create a local workspace task.');
    const connection = this.connection();
    const at = this.now();
    const taskId = this.randomId();
    const roundId = this.randomId();
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(
        draft,
        input.operationId,
        {
          kind: 'create-task',
          workspaceId: input.workspaceId,
          title: input.title,
          requirement: input.requirement,
          acceptance: input.acceptance,
          ...(input.mode === 'text' ? { mode: 'text' } : {}),
          repository: input.repository,
          remoteName: input.remoteName,
          baseSha: input.baseSha,
          targetBranch: input.targetBranch,
          environmentHint: input.environmentHint,
          ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        },
        taskId,
      );
      if (dedup.status === 'duplicate') {
        const existing = dedup.taskId ? draft.tasks.find(item => item.id === dedup.taskId) : undefined;
        if (!existing) throw dotBridgeError('duplicate-mismatch', 'operationId');
        return this.replay<Task>(draft, input.operationId, existing);
      }
      const task = createTask({
        id: taskId,
        connectionId: connection.id,
        mode: input.mode ?? 'git',
        workspaceId: input.workspaceId,
        repository: input.repository,
        remoteName: input.remoteName,
        branch: input.mode === 'text' ? null : `dot/${taskId}`,
        environmentHint: input.environmentHint,
        title: input.title,
        requirement: input.requirement,
        acceptance: input.acceptance,
        baseSha: input.baseSha,
        targetBranch: input.targetBranch,
        roundId,
        at,
      });
      task.workspaceRoot = input.workspaceRoot ?? null;
      const next = recordOperation(task, input.operationId, at);
      draft.tasks.push(next);
      this.emitTaskChanged(draft, next, 'created');
      const response = structuredClone(next);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  /** Publish a whole chat input (including a new round and files) in one durable transaction. */
  async providerPrompt(input: {
    id: string; operationId: string; clientMessageId: string; workspaceId: string; cwd: string;
    body: string; systemPrompt: string; attachments: AttachmentContent[];
  }): Promise<{ task: Task; duplicate: boolean }> {
    const files = input.attachments.map(content => ({ content, bytes: decodeAttachment(content) }));
    if (files.length > MAX_TASK_ATTACHMENTS) throw dotBridgeError('attachment-limit');
    const identity = { kind: 'provider-prompt', ...input };
    const blobs = new AttachmentStore(this.deps.store.dir);
    for (const file of files) await blobs.put(file.bytes);
    return this.deps.store.mutate(draft => {
      const duplicate = this.dedupOperation(draft, input.operationId, identity, input.id);
      if (duplicate.status === 'duplicate') return { task: this.replay<Task>(draft, input.operationId, this.requireTask(draft, input.id)), duplicate: true };
      const at = this.now();
      let task = draft.tasks.find(item => item.id === input.id);
      if (task) {
        if (task.mode !== 'text' || task.provider?.cwd !== input.cwd || task.workspaceId !== input.workspaceId) throw dotBridgeError('task-rejected', 'provider binding mismatch');
        if (currentRound(task).stop.requested && !['stopped', 'failed', 'completed'].includes(task.status)) throw dotBridgeError('stop-rejected', 'Waiting for Dot to acknowledge the stop request');
        if (task.status === 'completed') task = createNextRound(task, this.randomId(), at);
        else if (task.status === 'failed' || task.status === 'stopped') task = retryRoundState(task, task.currentRoundId, this.randomId(), at);
        task = appendUserMessage(task, input.body, task.status === 'waiting_user' ? 'answer' : 'requirement', at);
      } else {
        task = createTask({ id: input.id, connectionId: this.connection().id, workspaceId: input.workspaceId,
          mode: 'text', repository: null, remoteName: null, branch: null, baseSha: null, targetBranch: null,
          title: input.body.slice(0, 200), requirement: input.body, acceptance: input.systemPrompt,
          environmentHint: 'Conversation through the Paseo Dot provider. Use local file tools for requested code changes, then reply with submit_dot_text_result. Previous rounds are the conversation history.',
          roundId: this.randomId(), at });
        task.provider = { cwd: input.cwd, clientMessageIds: {} };
        task.workspaceRoot = input.cwd;
      }
      if (!task.workspaceRoot) task.workspaceRoot = input.cwd;
      const provider = task.provider!;
      task = { ...task, provider: { ...provider, clientMessageIds: { ...provider.clientMessageIds, [task.messageSeq]: input.clientMessageId } } };
      if (task.attachments.length + files.length > MAX_TASK_ATTACHMENTS) throw dotBridgeError('attachment-limit');
      for (const { content, bytes } of files) {
        const attachment: Attachment = { id: this.randomId(), roundId: task.currentRoundId, name: content.name,
          mediaType: content.mediaType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), author: 'user', createdAt: at };
        task = appendUserMessage(task, `Attachment: ${attachment.name} (${attachment.size} bytes; id: ${attachment.id})`, 'requirement', at);
        task.attachments.push(attachment);
      }
      task = recordOperation(task, input.operationId, at);
      if (draft.tasks.some(item => item.id === task.id)) this.replace(draft, task);
      else draft.tasks.push(task);
      this.emitTaskChanged(draft, task, 'message_added');
      const response = structuredClone(task);
      this.setReceipt(draft, input.operationId, response);
      return { task: response, duplicate: false };
    });
  }

  async uploadAttachment(input: AttachmentContent & {
    operationId: string; id: string; roundId: string;
    actor: 'user' | 'dot'; revision?: number; connectionId?: string;
  }): Promise<{ attachment: Attachment }> {
    const bytes = decodeAttachment(input);
    return this.publishAttachment(input, bytes);
  }

  private validateDotUpload(task: Task, roundId: string, connectionId: string | undefined, toolName: string, name: string): void {
    this.requireActiveDelivery(task);
    if (task.connectionId !== connectionId) throw dotBridgeError('connection-invalid');
    if (task.currentRoundId !== roundId) throw dotBridgeError('round-stale');
    const round = currentRound(task);
    if (round.stop.requested) throw dotBridgeError('task-rejected', 'stop requested');
    this.assertPermissionMutation(task, toolName, [name]);
    if (!round.claim || !['claimed', 'running', 'waiting_user'].includes(round.remoteStatus)) throw dotBridgeError('claim-required');
    if (task.attachments.length >= MAX_TASK_ATTACHMENTS) throw dotBridgeError('attachment-limit');
  }

  async uploadAttachmentChunk(input: AttachmentChunk & { taskId: string; roundId: string; connectionId: string; operationId: string }): Promise<{ complete: boolean; received: number[]; attachment?: Attachment }> {
    const bytes = decodeChunk(input);
    const task = this.task(input.taskId);
    if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
    const existing = task.attachments.find(file => file.id === input.operationId);
    if (existing) {
      if (existing.author !== 'dot' || existing.roundId !== input.roundId || existing.name !== input.name || existing.mediaType !== input.mediaType || existing.size !== input.size || existing.sha256 !== input.sha256) throw dotBridgeError('duplicate-mismatch', 'upload manifest');
      const blob = await new AttachmentStore(this.deps.store.dir).get(existing);
      if (!blob.subarray(input.index * ATTACHMENT_CHUNK_BYTES, (input.index + 1) * ATTACHMENT_CHUNK_BYTES).equals(bytes)) throw dotBridgeError('duplicate-mismatch', 'upload chunk');
      return { complete: true, received: Array.from({ length: Math.ceil(input.size / ATTACHMENT_CHUNK_BYTES) }, (_, i) => i), attachment: existing };
    }
    if (this.deps.store.read().dedup.operations[input.operationId]) throw dotBridgeError('duplicate-mismatch', 'operationId');
    this.validateDotUpload(task, input.roundId, input.connectionId, 'upload_dot_attachment_chunk', input.name);
    const staged = receiveChunk(this.deps.store.dir, input, this.now());
    if (!staged.bytes) return { complete: false, received: staged.received };
    const result = await this.publishAttachment({ ...input, id: input.taskId, actor: 'dot', permissionTool: 'upload_dot_attachment_chunk' }, staged.bytes);
    clearTransfer(this.deps.store.dir, input.taskId, input.operationId);
    return { complete: true, received: staged.received, ...result };
  }

  private async publishAttachment(input: Pick<AttachmentContent, 'name' | 'mediaType'> & {
    operationId: string; id: string; roundId: string; actor: 'user' | 'dot'; revision?: number; connectionId?: string; permissionTool?: string;
  }, bytes: Buffer): Promise<{ attachment: Attachment }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const content = { kind: 'attachment', id: input.id, roundId: input.roundId, actor: input.actor,
      revision: input.revision, connectionId: input.connectionId, name: input.name, mediaType: input.mediaType, sha256 };
    const validate = (task: Task) => {
      this.requireActiveDelivery(task);
      if (input.actor === 'dot') this.validateDotUpload(task, input.roundId, input.connectionId, input.permissionTool ?? 'upload_dot_attachment', input.name);
      if (task.currentRoundId !== input.roundId) throw dotBridgeError('round-stale');
      if (input.actor === 'user' && task.revision !== input.revision) throw dotBridgeError('revision-conflict');
      const round = currentRound(task);
      if (input.actor === 'dot' && (!round.claim || !['claimed', 'running', 'waiting_user'].includes(round.remoteStatus))) throw dotBridgeError('claim-required');
      if (task.attachments.length >= MAX_TASK_ATTACHMENTS) throw dotBridgeError('attachment-limit');
    };
    // Check identity before I/O. A successful upload can replay even after the round moved on.
    const snapshot = this.deps.store.read();
    const task = this.requireTask(snapshot, input.id);
    if (input.actor === 'dot' && task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
    const replayUpload = (draft: StoreFile, current: Task): { attachment: Attachment } => {
      const attachment = current.attachments.find(item => item.id === input.operationId);
      if (!attachment) throw dotBridgeError('operation-archived', input.operationId);
      return this.replay<{ attachment: Attachment }>(draft, input.operationId, { attachment });
    };
    const prior = snapshot.dedup.operations[input.operationId];
    if (prior) {
      this.dedupOperation(snapshot, input.operationId, content, input.id);
      return replayUpload(snapshot, task);
    }
    validate(task);
    // No metadata is published until the complete blob is durable. An interrupted upload may
    // leave an unreferenced private blob; it can never be read through the task API.
    await new AttachmentStore(this.deps.store.dir).put(bytes);
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, content, input.id);
      const current = this.requireTask(draft, input.id);
      if (dedup.status === 'duplicate') return replayUpload(draft, current);
      validate(current);
      const at = this.now();
      const attachment: Attachment = { id: input.operationId, roundId: input.roundId, name: input.name, mediaType: input.mediaType, size: bytes.length, sha256, author: input.actor, createdAt: at };
      if (input.actor === 'dot') attachment.localPath = saveDeliveredFile(this.deps.store.dir, input.id, input.operationId, input.name, bytes);
      const note = `Attachment: ${attachment.name} (${attachment.size} bytes; id: ${attachment.id})`;
      let next = input.actor === 'user'
        ? appendUserMessage(current, note, 'requirement', at)
        : appendDotMessage(current, input.roundId, 'note', note, at, input.operationId);
      next = recordOperation({ ...next, attachments: [...next.attachments, attachment] }, input.operationId, at);
      this.replace(draft, next);
      if (input.actor === 'user') this.emitTaskChanged(draft, next, 'message_added');
      const response = { attachment };
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  async readAttachment(id: string, attachmentId: string, connectionId?: string): Promise<{ attachment: Attachment; encoding: 'utf8' | 'base64'; content: string }> {
    const task = this.task(id);
    if (connectionId !== undefined && task.connectionId !== connectionId) throw dotBridgeError('connection-invalid');
    const attachment = task.attachments.find(item => item.id === attachmentId);
    if (!attachment) throw dotBridgeError('attachment-missing');
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw dotBridgeError('attachment-too-large', 'use read_dot_attachment_chunk for large files');
    const bytes = await new AttachmentStore(this.deps.store.dir).get(attachment);
    if (attachment.mediaType.startsWith('text/') || attachment.mediaType === 'application/json') {
      try { return { attachment, encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
      catch { /* Preserve arbitrary bytes even when a MIME type incorrectly claims UTF-8. */ }
    }
    return { attachment, encoding: 'base64', content: bytes.toString('base64') };
  }

  async readAttachmentChunk(id: string, attachmentId: string, index: number, connectionId?: string): Promise<{ attachment: Attachment; content: string; done: boolean }> {
    const task = this.task(id);
    if (connectionId !== undefined && task.connectionId !== connectionId) throw dotBridgeError('connection-invalid');
    const attachment = task.attachments.find(item => item.id === attachmentId);
    if (!attachment) throw dotBridgeError('attachment-missing');
    if (!Number.isInteger(index) || index < 0 || index >= Math.max(1, Math.ceil(attachment.size / ATTACHMENT_CHUNK_BYTES))) throw dotBridgeError('attachment-invalid', 'chunk index');
    const bytes = await new AttachmentStore(this.deps.store.dir).get(attachment);
    const end = (index + 1) * ATTACHMENT_CHUNK_BYTES;
    return { attachment, content: bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, end).toString('base64'), done: end >= bytes.length };
  }

  async addMessage(input: { id: string; revision: number; operationId: string; body: string; kind: 'requirement' | 'answer' }): Promise<Task> {
    this.requireActiveDelivery(this.task(input.id));
    const at = this.now();
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, { kind: 'message', id: input.id, revision: input.revision, body: input.body, messageKind: input.kind }, input.id);
      if (dedup.status === 'duplicate') return this.replay<Task>(draft, input.operationId, this.requireTask(draft, input.id));
      const task = this.requireTask(draft, input.id);
      this.requireRevision(task, input.revision);
      const next = recordOperation(appendUserMessage(task, input.body, input.kind, at), input.operationId, at);
      this.replace(draft, next);
      this.emitTaskChanged(draft, next, 'message_added');
      const response = structuredClone(next);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  async cancelRequest(input: { id: string; revision: number; operationId: string }): Promise<Task> {
    const at = this.now();
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, { kind: 'cancel', id: input.id, revision: input.revision }, input.id);
      if (dedup.status === 'duplicate') return this.replay<Task>(draft, input.operationId, this.requireTask(draft, input.id));
      const task = this.requireTask(draft, input.id);
      this.requireRevision(task, input.revision);
      const next = recordOperation(requestCancel(task, at), input.operationId, at);
      this.replace(draft, next);
      this.emitTaskChanged(draft, next, 'cancel_requested');
      const response = structuredClone(next);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  async createRound(input: { id: string; revision: number; operationId: string }): Promise<Task> {
    this.requireActiveDelivery(this.task(input.id));
    const at = this.now();
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, { kind: 'round', id: input.id, revision: input.revision }, input.id);
      if (dedup.status === 'duplicate') return this.replay<Task>(draft, input.operationId, this.requireTask(draft, input.id));
      const task = this.requireTask(draft, input.id);
      this.requireRevision(task, input.revision);
      const next = recordOperation(createNextRound(task, this.randomId(), at), input.operationId, at);
      this.replace(draft, next);
      this.emitTaskChanged(draft, next, 'created');
      const response = structuredClone(next);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  /**
   * Restarts work on the current round after the dot reported a failure or could not deliver a
   * verified commit. The same task, branch and fixed base are kept, but a *new* roundId is minted so
   * a late report from the previous attempt lands only in that attempt's history and cannot close
   * the new work. This is the explicit recovery path for failed, quota-blocked or delivery-blocked
   * work, and for a queued task canceled locally; it never creates a replacement task.
   */
  async retryRound(input: { id: string; revision: number; operationId: string }): Promise<Task> {
    this.requireActiveDelivery(this.task(input.id));
    const at = this.now();
    return this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, { kind: 'retry', id: input.id, revision: input.revision }, input.id);
      if (dedup.status === 'duplicate') return this.replay<Task>(draft, input.operationId, this.requireTask(draft, input.id));
      const task = this.requireTask(draft, input.id);
      this.requireRevision(task, input.revision);
      const next = recordOperation(retryRoundState(task, task.currentRoundId, this.randomId(), at), input.operationId, at);
      this.replace(draft, next);
      this.emitTaskChanged(draft, next, 'created');
      const response = structuredClone(next);
      this.setReceipt(draft, input.operationId, response);
      return response;
    });
  }

  /**
   * Dispatches queued tasks up to the in-flight cap, but only when the bridge is listening, a
   * verified task_changed route exists and the task's fixed base commit is currently served by its
   * bound remote. The Git check is asynchronous, so every precondition is re-read inside the same
   * serial mutate that commits the dispatch: a route revoked, a cap lowered, a slot taken or a
   * round changed during the Git check can never let a stale decision dispatch a new round. A task
   * whose base is unreachable gets a persisted waiting reason and is retried on a later tick, and it
   * never blocks other legal queued tasks.
   */
  async dispatchTick(): Promise<string[]> {
    const at = this.now();
    const snapshot = this.deps.store.read();
    const connection = snapshot.connection;
    if (!connection || !this.bridgeListening) return [];
    const route = this.activeSubscriptions(connection).some(sub => sub.name === 'paseo.dot.task_changed' && sub.verifiedAt !== null);
    if (!route || connection.dotVerifiedAt === null) return [];
    const free = Math.max(0, this.deps.getMaxInFlight() - inFlightCount(snapshot.tasks.filter(task => task.mode === 'text' || this.deps.git)));
    if (free === 0) return [];
    // Scan the whole queue, not just the first `free` entries: a task whose base is unreachable must
    // not starve the reachable tasks behind it. We stop only once enough reachable candidates fill
    // the free slots.
    const candidates = dispatchOrder(snapshot.tasks.filter(task => task.mode === 'text' || this.deps.git));
    const checked: Array<{ id: string; roundId: string; baseSha: string | null }> = [];
    const unreachable: string[] = [];
    for (const task of candidates) {
      if (checked.length >= free) break;
      const round = currentRound(task);
      // A candidate blocked very recently is skipped without another network probe; it keeps its
      // persisted reason and is re-checked on a later tick.
      if (round.dispatchBlocked && at - round.dispatchBlocked.at < RECHECK_MS) continue;
      const reachable = task.mode === 'text' || (task.repository !== null && round.baseSha !== null
        && await this.deps.git?.baseReachable(task.repository, round.baseSha).catch(() => false));
      if (reachable) checked.push({ id: task.id, roundId: round.roundId, baseSha: round.baseSha });
      else unreachable.push(task.id);
    }
    if (unreachable.length) await this.markUnreachable(unreachable, at);
    if (!checked.length) return [];
    return this.deps.store.mutate(draft => {
      const current = draft.connection;
      if (!current || !this.bridgeListening) return [];
      const routeNow = this.activeSubscriptions(current).some(sub => sub.name === 'paseo.dot.task_changed' && sub.verifiedAt !== null);
      if (!routeNow || current.dotVerifiedAt === null) return [];
      const freeNow = Math.max(0, this.deps.getMaxInFlight() - inFlightCount(draft.tasks.filter(task => task.mode === 'text' || this.deps.git)));
      const dispatched: string[] = [];
      for (const candidate of checked) {
        if (dispatched.length >= freeNow) break;
        const task = draft.tasks.find(item => item.id === candidate.id);
        if (!task) continue;
        const round = currentRound(task);
        // The candidate must still be the same queued round that was checked, or the decision is stale.
        if (round.roundId !== candidate.roundId || round.baseSha !== candidate.baseSha) continue;
        if (round.remoteStatus !== 'queued' || task.cancelRequested) continue;
        const next = withDispatch(task, at);
        this.replace(draft, next);
        this.wake(draft, next);
        dispatched.push(candidate.id);
      }
      return dispatched;
    });
  }

  /** Persists a visible reason for a queued round whose base commit cannot be reached right now. */
  private async markUnreachable(ids: string[], at: number): Promise<void> {
    await this.deps.store.mutate(draft => {
      for (const id of ids) {
        const index = draft.tasks.findIndex(item => item.id === id);
        if (index < 0) continue;
        draft.tasks[index] = markDispatchBlocked(draft.tasks[index], 'base-unreachable', at);
      }
    });
  }

  /**
   * Re-verifies the current round's result. The client passes the revision it saw; a replayed
   * operation id returns the stored receipt instead of running git again, and a reused id with
   * different content is rejected. Registration uses the same operation log as every other mutating
   * entry point (so an id is never forgotten while the store is retained), and it happens atomically
   * before the async Git run, so two concurrent calls with the same id share one run.
   */
  async refreshResult(input: { operationId: string; id: string; revision: number }): Promise<Task> {
    const content = { kind: 'refresh', id: input.id, revision: input.revision };
    const claim = await this.deps.store.mutate(draft => {
      const dedup = this.dedupOperation(draft, input.operationId, content, input.id);
      if (dedup.status === 'duplicate') {
        // An id migrated from the version-1 archive has no receipt and can never be replayed; refuse
        // it rather than running Git again under an id whose original outcome is gone.
        if (!dedup.replayable) throw dotBridgeError('operation-archived', input.operationId);
        return { status: 'existing' as const, receipt: draft.dedup.operations[input.operationId]?.receipt ?? null };
      }
      return { status: 'new' as const };
    });
    if (claim.status === 'existing') {
      const receipt = this.readReceipt<Task>(claim.receipt);
      if (receipt) return receipt;
      const inflight = this.refreshing.get(input.operationId);
      if (inflight) return inflight;
      // No receipt and no in-flight job: a crash left the registration behind. Re-run under the same
      // id rather than returning unrelated state.
    }
    const job = this.runRefresh(input);
    this.refreshing.set(input.operationId, job);
    try {
      return await job;
    } catch (error) {
      // The refresh did not complete; forget the id so the same operation can be retried cleanly.
      await this.deps.store.mutate(draft => { delete draft.dedup.operations[input.operationId]; }).catch(() => undefined);
      throw error;
    } finally {
      this.refreshing.delete(input.operationId);
    }
  }

  private async runRefresh(input: { operationId: string; id: string; revision: number }): Promise<Task> {
    const task = this.task(input.id);
    if (task.revision !== input.revision) throw dotBridgeError('revision-conflict', `expected ${task.revision}, got ${input.revision}`);
    const round = currentRound(task);
    if (!round.result || round.result.kind === 'text') throw dotBridgeError('task-rejected', 'no Git result to verify');
    const verification = await this.verify(task, round.roundId, round.result);
    return this.deps.store.mutate(draft => {
      const current = this.requireTask(draft, input.id);
      const currentRoundNow = currentRound(current);
      if (!currentRoundNow.result || currentRoundNow.result.updateId !== verification.updateId || currentRoundNow.result.headSha !== verification.headSha) {
        this.setReceipt(draft, input.operationId, current);
        return structuredClone(current);
      }
      const next = markVerification(current, round.roundId, verification, this.now());
      this.replace(draft, next);
      this.setReceipt(draft, input.operationId, next);
      return structuredClone(next);
    });
  }

  async processResult(input: {
    kind?: 'git' | 'text';
    connectionId: string;
    taskId: string;
    roundId: string;
    updateId: string;
    baseSha: string | null;
    headSha: string | null;
    branch: string | null;
    summary: string;
    checks: RoundResult['checks'];
    prUrl: string | null;
    processedThroughSeq: number;
  }): Promise<ResultOutcome> {
    this.requireActiveDelivery(this.task(input.taskId));
    // A duplicate that arrives while the first submission is still verifying shares that completion.
    const inflight = this.processing.get(input.updateId);
    if (inflight) {
      const shared = await inflight;
      return { ...shared, duplicate: true, reason: shared.reason === 'stale-round' ? 'stale-round' : 'duplicate' };
    }
    const job = this.processResultOnce(input);
    this.processing.set(input.updateId, job);
    try {
      return await job;
    } finally {
      this.processing.delete(input.updateId);
    }
  }

  /**
   * The first submission of an updateId is reduced and saved, then Git-verified outside the slot. Its
   * outcome is stored on the updateId (provisionally before Git, finally after), so a replay always
   * returns that updateId's own outcome — never a later head, coverage or verification borrowed from
   * the mutable current round. A late report for an older round is stored and finalized immediately
   * without Git.
   */
  private async processResultOnce(input: {
    kind?: 'git' | 'text';
    connectionId: string;
    taskId: string;
    roundId: string;
    updateId: string;
    baseSha: string | null;
    headSha: string | null;
    branch: string | null;
    summary: string;
    checks: RoundResult['checks'];
    prUrl: string | null;
    processedThroughSeq: number;
  }): Promise<ResultOutcome> {
    const at = this.now();
    const hash = stableHash({ ...input, kind: 'result' });
    const first = await this.deps.store.mutate(draft => {
      const outcome = this.dedupUpdate(draft, input.updateId, hash);
      const task = this.requireTask(draft, input.taskId);
      if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
      if (outcome === 'duplicate') {
        // Return this updateId's own stored outcome; never assemble it from the round's current state.
        return { kind: 'duplicate' as const, task, stored: this.readOutcome(draft, input.updateId) };
      }
      // Validate against the round the result names, not the current round, so a real new round
      // does not turn a legitimate old-round report into a base mismatch.
      const round = task.rounds.find(item => item.roundId === input.roundId);
      if (!round) throw dotBridgeError('round-missing', input.roundId);
      if (input.baseSha !== round.baseSha) throw dotBridgeError('base-mismatch');
      const result = resultSchema.parse({
        kind: input.kind ?? 'git',
        baseSha: input.baseSha,
        headSha: input.headSha,
        branch: input.branch,
        summary: input.summary,
        checks: input.checks,
        prUrl: input.prUrl,
        reportedAt: at,
        updateId: input.updateId,
        processedThroughSeq: input.processedThroughSeq,
        coversLatest: false,
      });
      const reduced = reduceResult(task, { roundId: input.roundId, ...result });
      this.replace(draft, reduced.task);
      if (!reduced.applied) {
        // A late report for an older round: no Git runs, so its outcome is final now.
        const staleRound = reduced.task.rounds.find(item => item.roundId === input.roundId) ?? currentRound(reduced.task);
        const storedOutcome: ResultOutcome = { accepted: true, coversLatest: false, duplicate: false, reason: 'stale-round', verification: staleRound.verification };
        this.recordUpdate(draft, input.updateId, hash, storedOutcome);
        return { kind: 'done' as const, stored: storedOutcome };
      }
      // A result that does not cover the latest user message must wake the dot to read the rest.
      if (!reduced.coversLatest) this.wake(draft, reduced.task);
      // Persist a provisional outcome before Git so a crash mid-verification still replays this
      // updateId's own submission outcome (its coverage and head), never a later round's state.
      const provisional: ResultOutcome = {
        accepted: true,
        coversLatest: reduced.coversLatest,
        duplicate: false,
        reason: 'ok',
        verification: currentRound(reduced.task).verification,
      };
      this.recordUpdate(draft, input.updateId, hash, provisional);
      if (result.kind === 'text') return { kind: 'done' as const, stored: provisional };
      return { kind: 'pending' as const, task: reduced.task, coversLatest: reduced.coversLatest };
    });
    if (first.kind === 'done') return first.stored;
    if (first.kind === 'duplicate') {
      const stored = first.stored;
      if (!stored) {
        // The id is recorded (so the report is never re-applied) but its outcome was not retained —
        // a version-1 record migrated without a response. Refuse to invent one from mutable state.
        return { accepted: true, coversLatest: false, duplicate: true, reason: 'stale-round', verification: emptyVerification() };
      }
      return { ...stored, duplicate: true, reason: stored.reason === 'stale-round' ? 'stale-round' : 'duplicate' };
    }
    // Git verification runs outside the slot; the result is already saved.
    const result = currentRound(first.task).result;
    if (!result) throw dotBridgeError('task-rejected');
    const verification = await this.verify(first.task, input.roundId, result);
    const finalOutcome: ResultOutcome = { accepted: true, coversLatest: first.coversLatest, duplicate: false, reason: 'ok', verification };
    await this.deps.store.mutate(draft => {
      const current = this.requireTask(draft, input.taskId);
      const round = current.rounds.find(item => item.roundId === input.roundId);
      // Drop a verification that no longer matches the result it was computed for, but keep the
      // provisional outcome so the id still replays this updateId's own submission.
      if (!round || !round.result || round.result.updateId !== verification.updateId || round.result.headSha !== verification.headSha) {
        return;
      }
      const next = markVerification(current, input.roundId, verification, this.now());
      this.replace(draft, next);
      this.recordUpdate(draft, input.updateId, hash, finalOutcome);
    });
    return finalOutcome;
  }

  async reportProgress(input: {
    connectionId: string;
    taskId: string;
    roundId: string;
    updateId: string;
    kind: 'running' | 'waiting_user' | 'failed' | 'stopped';
    note: string;
    processedThroughSeq: number;
  }): Promise<{ applied: boolean; reason: string; duplicate: boolean }> {
    this.requireActiveDelivery(this.task(input.taskId));
    const at = this.now();
    const hash = stableHash({ ...input, kind2: 'progress' });
    return this.deps.store.mutate(draft => {
      const outcome = this.dedupUpdate(draft, input.updateId, hash);
      const task = this.requireTask(draft, input.taskId);
      if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
      if (outcome === 'duplicate') {
        // Return this updateId's own stored outcome, never the round's later status.
        const stored = this.readReceipt<{ applied: boolean; reason: string }>(draft.dedup.updateIds[input.updateId]?.response ?? null);
        if (stored) return { applied: stored.applied, reason: stored.reason, duplicate: true };
        // A record migrated from version 1 has no stored outcome; it is treated as history-only.
        return { applied: false, reason: 'history', duplicate: true };
      }
      const reduced = reduceProgress(task, { ...input, at });
      // Even a history-only report is persisted, so a late report is not silently dropped.
      this.replace(draft, reduced.task);
      const response = { applied: reduced.applied, reason: reduced.reason };
      this.recordUpdate(draft, input.updateId, hash, response);
      return { ...response, duplicate: false };
    });
  }

  async claimTask(input: { connectionId: string; taskId: string; roundId: string }): Promise<{ claimedAt: number; taskId: string; created: boolean }> {
    this.requireActiveDelivery(this.task(input.taskId));
    const at = this.now();
    return this.deps.store.mutate(draft => {
      const task = this.requireTask(draft, input.taskId);
      const outcome = claimRound(task, input.connectionId, input.roundId, at);
      if (outcome.created) this.replace(draft, outcome.task);
      return { ...outcome.claim, created: outcome.created };
    });
  }

  /** Dot asks; only the authenticated local UI/provider can resolve this request. */
  async requestPermission(input: PermissionIntent & { connectionId: string; taskId: string; roundId: string }): Promise<DotPermission> {
    const { connectionId, taskId, roundId, ...raw } = input;
    const intent = permissionIntentSchema.parse(raw);
    return this.deps.store.mutate(draft => {
      const task = this.requireTask(draft, taskId);
      if (task.connectionId !== connectionId) throw dotBridgeError('connection-invalid');
      const prior = task.permissions.find(p => p.requestId === intent.requestId);
      if (prior) {
        const previous = { requestId: prior.requestId, userMessageSeq: prior.userMessageSeq, title: prior.title, description: prior.description, scope: prior.scope };
        if (prior.roundId !== roundId || stableHash(previous) !== stableHash(intent)) throw dotBridgeError('duplicate-mismatch');
        return structuredClone(prior);
      }
      this.requirePermissionRound(task, roundId);
      if (task.userMessageSeq !== intent.userMessageSeq) throw dotBridgeError('permission-stale', 'A newer user message arrived');
      if (pendingPermissions(task).length) throw dotBridgeError('permission-required', 'Resolve the pending request first');
      if (task.permissions.some(p => permissionCurrent(task, p) && (p.status === 'denied' || p.platformBlock))) {
        throw dotBridgeError('permission-required', 'Do not repeat a denied request without new user input');
      }
      const at = this.now();
      const permission: DotPermission = { ...intent, roundId, status: 'pending', requestedAt: at, resolvedAt: null, decisionMessageSeq: null, platformBlock: null };
      const next = reduceProgress({ ...task, permissions: [...task.permissions, permission] }, {
        roundId, updateId: `permission:${intent.requestId}`, kind: 'waiting_user',
        processedThroughSeq: intent.userMessageSeq, note: `需要你确认：${intent.title}\n${permissionDescription(intent)}\n请在 Paseo 的授权卡片选择允许或拒绝，也可在 Dot tasks 详情中处理。`, at,
      }).task;
      this.replace(draft, next);
      return structuredClone(permission);
    });
  }

  /** Not exposed as an MCP tool: a Dot tool call cannot manufacture a local approval. */
  async respondPermission(input: { taskId: string; requestId: string; decision: 'approved' | 'denied' }): Promise<DotPermission> {
    return this.deps.store.mutate(draft => {
      const task = this.requireTask(draft, input.taskId);
      const permission = task.permissions.find(p => p.requestId === input.requestId);
      if (!permission) throw dotBridgeError('permission-stale');
      if (permission.status === input.decision) return structuredClone(permission);
      if (permission.status !== 'pending' || !permissionCurrent(task, permission)) throw dotBridgeError('permission-stale');
      const at = this.now();
      const verb = input.decision === 'approved' ? '允许' : '拒绝';
      const next = appendUserMessage(task, `用户在 Paseo ${verb}本次请求「${permission.title}」（${permission.requestId}）。\n${permissionDescription(permission)}\n${input.decision === 'approved' ? '请核对最新任务，仅在上述范围内继续；如 ChatGPT 平台仍拒绝，回报平台阻塞，不得绕过。' : '不要执行被拒绝的操作。请说明未完成部分或提供不需要该操作的答复。'}`, 'answer', at);
      const result: DotPermission = { ...permission, status: input.decision, resolvedAt: at, decisionMessageSeq: next.userMessageSeq };
      next.permissions = next.permissions.map(p => p.requestId === permission.requestId ? result : p);
      this.replace(draft, next);
      this.emitTaskChanged(draft, next, 'message_added');
      return structuredClone(result);
    });
  }

  async reportPermissionBlocked(input: { connectionId: string; taskId: string; roundId: string; requestId: string; reason: string }): Promise<DotPermission> {
    if (!input.reason.trim() || input.reason.length > 2000) throw dotBridgeError('task-rejected', 'Invalid platform refusal reason');
    return this.deps.store.mutate(draft => {
      const task = this.requireTask(draft, input.taskId);
      if (task.connectionId !== input.connectionId) throw dotBridgeError('connection-invalid');
      const permission = task.permissions.find(p => p.requestId === input.requestId);
      if (!permission || permission.roundId !== input.roundId || permission.status !== 'approved') throw dotBridgeError('permission-required');
      if (permission.platformBlock) {
        if (permission.platformBlock.reason !== input.reason) throw dotBridgeError('duplicate-mismatch');
        return structuredClone(permission);
      }
      if (!permissionCurrent(task, permission)) throw dotBridgeError('permission-stale');
      const at = this.now(), blocked = { ...permission, platformBlock: { reason: input.reason, at } };
      const next = reduceProgress({ ...task, permissions: task.permissions.map(p => p.requestId === input.requestId ? blocked : p) }, {
        roundId: input.roundId, updateId: `permission-block:${input.requestId}`, kind: 'waiting_user', processedThroughSeq: task.userMessageSeq, at,
        note: `仍需在 Your dot 确认：${permission.title}\nPaseo 已记录你的允许，但 ChatGPT 平台尚未批准。\n${input.reason}\n\n操作：${permission.scope.action}\n范围：${permission.scope.targets.join('、')}\n请打开 ${DOT_CONFIRMATION_URL} 核对并确认具体操作；完成后回到本会话告知 Dot。不要重复点击本地允许来绕过平台检查。`,
      }).task;
      this.replace(draft, next);
      return structuredClone(blocked);
    });
  }

  private requirePermissionRound(task: Task, roundId: string): void {
    if (task.mode !== 'text' || task.currentRoundId !== roundId) throw dotBridgeError('permission-stale');
    const round = currentRound(task);
    if (!round.claim || round.stop.requested || !['claimed', 'running', 'waiting_user'].includes(task.status)) throw dotBridgeError('permission-stale');
  }

  private assertPermissionMutation(task: Task, toolName?: string, targets: string[] = []): void {
    const current = task.permissions.filter(p => permissionCurrent(task, p));
    if (current.some(p => p.status === 'pending' || p.status === 'denied' || p.platformBlock)) throw dotBridgeError('permission-required');
    const approved = current.filter(p => p.status === 'approved');
    if (approved.length && (!approved.some(p => p.scope.toolName === toolName) || targets.some(target => !approved.some(p => p.scope.toolName === toolName && p.scope.targets.includes(target))))) throw dotBridgeError('permission-required', 'Outside the approved tool or targets');
  }

  listForConnection(connectionId: string, cursor: string | null, limit = 20): { tasks: TaskSummary[]; cursor: string | null } {
    const connection = this.connection();
    if (connection.id !== connectionId) throw dotBridgeError('connection-invalid');
    const all = this.deps.store.read().tasks
      .filter(task => task.connectionId === connectionId && (task.mode === 'text' || this.deps.git))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const start = cursor ? all.findIndex(task => task.id === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    return {
      tasks: page.map(task => this.summarize(task)),
      cursor: start + limit < all.length ? page[page.length - 1]?.id ?? null : null,
    };
  }

  summarize(task: Task): TaskSummary {
    const round = currentRound(task);
    return {
      mode: task.mode,
      taskId: task.id,
      title: task.title,
      branch: task.branch,
      status: round.remoteStatus,
      roundId: round.roundId,
      messageSeq: task.messageSeq,
      userMessageSeq: task.userMessageSeq,
      processedThroughSeq: round.processedThroughSeq,
      claimable: round.remoteStatus === 'dispatched' && round.claim === null,
      stopRequested: round.stop.requested && !round.stop.reported,
      waitingReason: round.dispatchBlocked?.reason ?? null,
      verificationStatus: round.verification.status,
      createdAt: task.createdAt,
    };
  }

  getForConnection(connectionId: string, taskId: string): Task {
    const task = this.task(taskId);
    if (task.connectionId !== connectionId) throw dotBridgeError('connection-invalid');
    return task;
  }

  /**
   * A paged view of every result ever delivered for a task, newest rounds first, so a long history
   * is queryable without loading the whole task. Results are never truncated; this only pages them.
   */
  historyForTask(taskId: string, cursor: string | null, limit = 50): {
    records: Array<{ roundId: string; result: RoundResult; verification: Verification; current: boolean }>;
    cursor: string | null;
  } {
    const task = this.task(taskId);
    const all: Array<{ roundId: string; result: RoundResult; verification: Verification; current: boolean }> = [];
    for (const round of [...task.rounds].reverse()) {
      const current = round.roundId === task.currentRoundId;
      if (round.result) all.push({ roundId: round.roundId, result: round.result, verification: round.verification, current });
      for (const record of [...round.resultHistory].reverse()) {
        all.push({ roundId: round.roundId, result: record.result, verification: record.verification, current: false });
      }
    }
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const page = all.slice(start, start + limit);
    return { records: page, cursor: start + limit < all.length ? String(start + limit) : null };
  }

  async recover(): Promise<void> {
    // Older versions left canceled, unclaimed dispatches occupying slots until an impossible
    // remote acknowledgement. Finish only those recorded stop requests; a missing heartbeat
    // never releases claimed work or re-dispatches an active round.
    await this.deps.store.mutate(draft => {
      for (const task of [...draft.tasks]) {
        const round = currentRound(task);
        if (round.remoteStatus !== 'dispatched' || round.claim || round.claimedAt !== null || !round.stop.requested) continue;
        const stopped = requestCancel(task, this.now());
        this.replace(draft, stopped);
        this.emitTaskChanged(draft, stopped, 'cancel_requested');
      }
    });
    await this.deliverTick();
  }

  /** Delivers due events, re-checking the callback address and matching each event to a subscription. */
  async deliverTick(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const state = this.deps.store.read();
      const connection = state.connection;
      if (!connection) return;
      const at = this.now();
      const decisions: Array<{ eventId: string; subscriptionId: string | null; action: 'delivered' | 'retry' | 'failed'; nextAttemptAt?: number; attempts?: number; error?: string }> = [];
      for (const event of state.events) {
        // Address-policy failures never sent a request. Re-check them so a proxy/DNS change or
        // the fake-IP compatibility fix can recover the original event without duplicating work.
        const recheckAddress = event.status === 'failed' && event.attempts === 0 && event.lastError === 'callback-invalid: private-address';
        if (event.status === 'delivered' || (event.status === 'failed' && !recheckAddress)) continue;
        if (event.nextAttemptAt > at) continue;
        const subscription = this.matchSubscription(connection, event);
        if (!subscription) continue;
        // Delivery stops strictly at the granted expiry; an expired route is never used.
        if (subscription.expiresAt !== null && subscription.expiresAt <= at) continue;
        if (subscription.verifiedAt === null) continue;
        const secret = this.secrets[`sub:${subscription.id}`];
        if (!secret) continue;
        let address: string | undefined;
        if (!this.deps.allowPrivateCallback) {
          const check = await checkCallbackUrl(subscription.url, this.deps.lookup, this.abort.signal);
          if (!check.ok) {
            if (!recheckAddress) decisions.push({ eventId: event.eventId, subscriptionId: subscription.id, action: 'failed', error: `callback-invalid: ${check.reason}` });
            continue;
          }
          address = check.address;
        }
        const decision = await this.deliverOne(event, subscription, secret, at, address);
        decisions.push(decision);
      }
      if (!decisions.length) {
        await this.pruneEvents();
        return;
      }
      await this.deps.store.mutate(draft => {
        const current = draft.connection;
        for (const decision of decisions) {
          const event = draft.events.find(item => item.eventId === decision.eventId);
          if (!event) continue;
          event.subscriptionId = decision.subscriptionId;
          if (decision.action === 'delivered') {
            event.status = 'delivered';
            event.lastError = null;
            if (current) {
              current.lastCallbackAt = at;
              const subscription = decision.subscriptionId ? current.subscriptions.find(sub => sub.id === decision.subscriptionId) : undefined;
              if (subscription) {
                subscription.verifiedAt = subscription.verifiedAt ?? at;
                subscription.updatedAt = at;
                current.callbackVerifications[subscription.id] = current.callbackVerifications[subscription.id] ?? at;
              }
            }
            // A delivered task_changed means the dot's callback received the message.
            this.markMessagesDelivered(draft, event, at);
          } else if (decision.action === 'failed') {
            event.status = 'failed';
            event.lastError = decision.error ?? 'delivery failed';
            this.markMessagesDelivery(draft, event, 'failed', decision.error ?? 'delivery failed', at);
          } else {
            event.attempts = decision.attempts ?? event.attempts + 1;
            event.nextAttemptAt = decision.nextAttemptAt ?? at + backoff(event.attempts);
            event.lastError = decision.error ?? null;
          }
        }
        this.prune(draft, at);
      });
    } finally {
      this.delivering = false;
    }
  }

  /** The active, preferably verified subscription that should receive this event. */
  private matchSubscription(connection: Connection, event: PendingEvent): Subscription | null {
    const at = this.now();
    const candidates = connection.subscriptions.filter(sub => {
      if (sub.name !== event.name) return false;
      if (sub.expiresAt !== null && sub.expiresAt <= at) return false;
      const arg = sub.arguments.connectionId;
      return arg === undefined || arg === event.connectionId;
    });
    if (!candidates.length) return null;
    const pinned = event.subscriptionId ? candidates.find(sub => sub.id === event.subscriptionId) : undefined;
    if (pinned) return pinned;
    const verified = candidates.filter(sub => sub.verifiedAt !== null);
    const pool = verified.length ? verified : candidates;
    return [...pool].sort((left, right) => left.createdAt - right.createdAt)[0];
  }

  private async deliverOne(
    event: PendingEvent,
    subscription: Subscription,
    secret: string,
    at: number,
    address?: string,
  ): Promise<{ eventId: string; subscriptionId: string | null; action: 'delivered' | 'retry' | 'failed'; nextAttemptAt?: number; attempts?: number; error?: string }> {
    const payload = JSON.stringify({
      eventId: event.eventId,
      name: event.name,
      // The occurrence time is stable across retries; only the signature timestamp moves.
      timestamp: new Date(event.createdAt).toISOString(),
      data: event.data,
      cursor: null,
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_BYTES) {
      return { eventId: event.eventId, subscriptionId: subscription.id, action: 'failed', error: 'payload-too-large' };
    }
    const timestamp = String(Math.floor(at / 1000));
    const prevUntil = Number(this.secrets[`sub:${subscription.id}:prevUntil`] ?? '0');
    const previous = this.secrets[`sub:${subscription.id}:prev`];
    const secrets = previous && at < prevUntil ? [secret, previous] : [secret];
    const signature = signPayloadMulti(secrets, event.eventId, timestamp, payload);
    const response = await postSigned(
      subscription.url,
      payload,
      {
        'content-type': 'application/json',
        'webhook-id': event.eventId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'X-MCP-Subscription-Id': subscription.id,
      },
      this.fetchImpl,
      this.abort.signal,
      address,
    );
    if (response.status >= 200 && response.status < 300) return { eventId: event.eventId, subscriptionId: subscription.id, action: 'delivered' };
    // 410 Gone and 413 Payload Too Large are permanent; do not retry them.
    if (response.status === 410 || response.status === 413) {
      return { eventId: event.eventId, subscriptionId: subscription.id, action: 'failed', error: `HTTP ${response.status}` };
    }
    const attempts = event.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      return { eventId: event.eventId, subscriptionId: subscription.id, action: 'failed', attempts, error: response.error ?? `HTTP ${response.status}` };
    }
    if (response.status === 429 && response.retryAfterSeconds !== null) {
      return { eventId: event.eventId, subscriptionId: subscription.id, action: 'retry', attempts, nextAttemptAt: at + response.retryAfterSeconds * 1000, error: 'rate limited' };
    }
    return { eventId: event.eventId, subscriptionId: subscription.id, action: 'retry', attempts, nextAttemptAt: at + backoff(attempts), error: response.error ?? `HTTP ${response.status}` };
  }

  private async pruneEvents(): Promise<void> {
    const at = this.now();
    await this.deps.store.mutate(draft => this.prune(draft, at));
  }

  private prune(draft: StoreFile, at: number): void {
    draft.events = draft.events.filter(event => event.status !== 'delivered' || at - event.createdAt < PRUNE_AFTER);
  }

  /** User messages up to the delivered event's messageSeq are marked as received by the dot. */
  private markMessagesDelivered(draft: StoreFile, event: PendingEvent, at: number): void {
    this.markMessagesDelivery(draft, event, 'delivered', null, at);
  }

  private markMessagesDelivery(draft: StoreFile, event: PendingEvent, delivery: 'delivered' | 'failed', error: string | null, at: number): void {
    const taskId = event.data.taskId;
    const seq = event.data.messageSeq;
    if (typeof taskId !== 'string' || typeof seq !== 'number') return;
    const index = draft.tasks.findIndex(task => task.id === taskId);
    if (index < 0) return;
    let task = draft.tasks[index];
    for (const message of task.messages) {
      if (message.author === 'user' && message.seq <= seq && message.delivery !== delivery) {
        task = markDelivery(task, message.seq, delivery, error, at);
      }
    }
    draft.tasks[index] = task;
  }

  /** Verifies the delivered branch against the bound remote and binds the result to its identity. */
  private async verify(task: Task, roundId: string, result: RoundResult): Promise<Verification> {
    if (!this.deps.git) throw dotBridgeError('task-rejected', 'Git delivery has been removed.');
    if (result.kind !== 'git' || !task.repository || !task.branch) throw dotBridgeError('task-rejected', 'no Git binding');
    const at = this.now();
    const base = { ...emptyVerification(), updateId: result.updateId, headSha: result.headSha };
    const prOk = await this.deps.git
      .prMatches({ prUrl: result.prUrl, remote: task.repository, taskBranch: task.branch, headSha: result.headSha })
      .catch(() => false);
    if (!prOk) {
      return { ...base, status: 'failed', at, error: 'pr-mismatch' };
    }
    const outcome = await this.deps.git.verifyResult({
      remote: task.repository,
      branch: result.branch,
      baseSha: result.baseSha,
      headSha: result.headSha,
      taskBranch: task.branch,
    });
    if (!outcome.ok) {
      return { ...base, status: 'failed', at, error: `${outcome.code}: ${outcome.detail}` };
    }
    // The remote branch may have moved between the report and the fetch; refuse to call it verified.
    if (outcome.branchHead !== result.headSha) {
      return { ...base, status: 'failed', at, error: `branch-moved: remote branch is at ${outcome.branchHead}` };
    }
    return {
      status: 'verified',
      at,
      error: null,
      files: outcome.files,
      patch: outcome.patch,
      truncated: outcome.truncated,
      verifiedHead: outcome.branchHead,
      coversLatest: false,
      updateId: result.updateId,
      headSha: result.headSha,
    };
  }

  private emitTaskChanged(draft: StoreFile, task: Task, kind: 'created' | 'message_added' | 'cancel_requested'): void {
    const round = currentRound(task);
    const data = taskChangedDataSchema.parse({ taskId: task.id, roundId: round.roundId, kind, messageSeq: task.messageSeq });
    this.emit(draft, 'paseo.dot.task_changed', task.connectionId, data);
  }

  /** A wake event is only queued when the task has no undelivered event already waiting. */
  private wake(draft: StoreFile, task: Task): void {
    const pending = draft.events.some(event => event.status !== 'delivered' && event.status !== 'failed' && event.data.taskId === task.id);
    if (pending) return;
    this.emitTaskChanged(draft, task, 'created');
  }

  private emit(draft: StoreFile, name: McpEventType, connectionId: string, data: Record<string, unknown>): string {
    const eventId = this.randomId();
    draft.events.push({
      eventId,
      name,
      connectionId,
      subscriptionId: null,
      data,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: this.now(),
    });
    return eventId;
  }

  /** Reads a stored operation receipt, tolerating a receipt that was pruned or never written. */
  private readReceipt<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Reads an updateId's stored outcome, or null when it was never finalized or is not a full result
   * outcome (a version-1 record, or a version-2 partial). Returning null makes the caller use a safe
   * unverified fallback rather than emitting a malformed outcome.
   */
  private readOutcome(draft: StoreFile, updateId: string): ResultOutcome | null {
    const parsed = this.readReceipt<unknown>(draft.dedup.updateIds[updateId]?.response ?? null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.accepted !== 'boolean') return null;
    const verification = record.verification;
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return null;
    return parsed as ResultOutcome;
  }

  /**
   * Returns the stored receipt for a replayed operation, so the caller gets the exact response the
   * first call produced. Receipts are never cleared while the id is live, so a missing receipt means
   * the id was archived; it is refused rather than answered with later state, which could differ
   * from the original response.
   */
  private replay<T>(draft: StoreFile, operationId: string, _fallback: T): T {
    const receipt = this.readReceipt<T>(draft.dedup.operations[operationId]?.receipt ?? null);
    if (receipt === null) throw dotBridgeError('operation-archived', operationId);
    return receipt;
  }

  /** Stores the exact response so a replay of the same operation returns the same bytes. */
  private setReceipt(draft: StoreFile, operationId: string, value: unknown): void {
    const record = draft.dedup.operations[operationId];
    if (!record) return;
    record.receipt = JSON.stringify(value);
    record.at = this.now();
  }

  /**
   * Replaying an operation returns the stored result; the same id with different content is rejected.
   * Operation records are never pruned by count: while a task's history is retained, its operation
   * ids must still resolve, or a replay would re-execute work (a second task, a second Git run).
   */
  private dedupOperation(
    draft: StoreFile,
    operationId: string,
    content: unknown,
    taskId: string | null,
  ): { status: 'new' } | { status: 'duplicate'; taskId: string | null; replayable: boolean } {
    const hash = stableHash(content);
    const existing = draft.dedup.operations[operationId];
    if (existing === undefined) {
      draft.dedup.operations[operationId] = { hash, taskId, receipt: null, replayable: true, at: this.now() };
      return { status: 'new' };
    }
    if (existing.hash !== hash) throw dotBridgeError('duplicate-mismatch', 'operationId');
    return { status: 'duplicate', taskId: existing.taskId, replayable: existing.replayable };
  }

  /** Looks up an updateId without writing; the digest still rejects a reused id with a different body. */
  private dedupUpdate(draft: StoreFile, updateId: string, hash: string): 'new' | 'duplicate' {
    const existing = draft.dedup.updateIds[updateId];
    if (existing === undefined) return 'new';
    if (existing.hash !== hash) throw dotBridgeError('duplicate-mismatch', 'updateId');
    return 'duplicate';
  }

  /** Records an updateId's digest and its original outcome, so a replay returns that outcome. */
  private recordUpdate(draft: StoreFile, updateId: string, hash: string, response: unknown): void {
    draft.dedup.updateIds[updateId] = { hash, response: JSON.stringify(response), at: this.now() };
  }

  private requireTask(draft: StoreFile, id: string): Task {
    const task = draft.tasks.find(item => item.id === id);
    if (!task) throw dotBridgeError('task-missing');
    return task;
  }

  private requireRevision(task: Task, revision: number): void {
    if (task.revision !== revision) throw dotBridgeError('revision-conflict', `expected ${task.revision}, got ${revision}`);
  }

  private replace(draft: StoreFile, task: Task): void {
    const index = draft.tasks.findIndex(item => item.id === task.id);
    if (index < 0) throw dotBridgeError('task-missing');
    const next = recomputeCoverage(task);
    next.permissions = next.permissions.map(p => p.status === 'pending' && !permissionCurrent(next, p)
      ? { ...p, status: 'expired', resolvedAt: this.now() } : p);
    draft.tasks[index] = next;
  }

  slotsUsed(): number {
    return inFlightCount(this.deps.store.read().tasks);
  }
}

export type ToolOutcome = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export function toolOutcome(value: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export { MAX_EVENT_BYTES };
export type { ToolName };
