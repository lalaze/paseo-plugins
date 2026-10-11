/**
 * Task, round, message, event, subscription and connection shapes shared by the client and the
 * server. `.strict()` rejects a renamed field instead of silently ignoring it, and every shape
 * that crosses the disk or the network is validated with these schemas.
 */
import { z } from 'zod';
import { localReceiptSchema } from './local-files';
import { attachmentSchema, MAX_TASK_ATTACHMENTS } from './attachments';

export const shaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
export const branchSchema = z
  .string()
  .regex(/^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/);
export const uuidSchema = z.string().uuid();
/** Bridge-assigned connection id. Not an OpenAI dot identity. */
export const connectionIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const httpsUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(value => value.startsWith('https://'), 'callback must be HTTPS');

/** Notification delivery is modelled apart from remote work and from code verification. */
export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'failed'] as const;
export const REMOTE_STATUSES = ['queued', 'dispatched', 'claimed', 'running', 'waiting_user', 'completed', 'failed', 'stopped'] as const;
export const VERIFY_STATUSES = ['none', 'verifying', 'verified', 'failed'] as const;
export const MESSAGE_AUTHORS = ['user', 'dot'] as const;
export const MESSAGE_KINDS = ['requirement', 'answer', 'question', 'progress', 'result', 'error', 'note'] as const;

export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export const remoteStatusSchema = z.enum(REMOTE_STATUSES);
export const verifyStatusSchema = z.enum(VERIFY_STATUSES);

export const checkRecordSchema = z
  .object({
    command: z.string().min(1).max(2000),
    result: z.string().max(8000),
    passed: z.boolean().nullable().default(null),
  })
  .strict();

export const messageSchema = z
  .object({
    seq: z.number().int().positive(),
    /** The round this message belongs to, so history stays attributable after a new round starts. */
    roundId: uuidSchema,
    author: z.enum(MESSAGE_AUTHORS),
    kind: z.enum(MESSAGE_KINDS),
    body: z.string().min(1).max(20_000),
    at: z.number().int().nonnegative(),
    /** User messages move through delivery states; dot messages are already "delivered". */
    delivery: deliveryStatusSchema,
    deliveryError: z.string().max(2000).nullable().default(null),
    /** Set when a dot report acknowledges this message (processedThroughSeq). */
    updateId: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

export const verificationSchema = z
  .object({
    status: verifyStatusSchema,
    at: z.number().int().nonnegative().nullable().default(null),
    error: z.string().max(4000).nullable().default(null),
    files: z.array(z.string()).default([]),
    patch: z.string().default(''),
    truncated: z.boolean().default(false),
    /** The head the branch pointed at when it was fetched; kept so a moved branch is visible. */
    verifiedHead: shaSchema.nullable().default(null),
    /** True when the delivered result covered every user message that existed at submit time. */
    coversLatest: z.boolean().default(false),
    /** Identity of the result this verification belongs to, so a stale completion cannot overwrite a newer one. */
    updateId: z.string().min(1).max(200).nullable().default(null),
    headSha: shaSchema.nullable().default(null),
  })
  .strict();

const resultCommon = {
  summary: z.string().max(20_000),
  checks: z.array(checkRecordSchema).max(100).default([]),
  reportedAt: z.number().int().nonnegative(),
  updateId: z.string().min(1).max(200),
  processedThroughSeq: z.number().int().nonnegative(),
  coversLatest: z.boolean().default(false),
};

export const resultSchema = z.union([
  z.object({
    ...resultCommon,
    kind: z.literal('git').default('git'),
    baseSha: shaSchema,
    headSha: shaSchema,
    branch: branchSchema,
    prUrl: z.string().url().max(2000).nullable().default(null),
  }).strict(),
  z.object({
    ...resultCommon,
    kind: z.literal('text'),
    summary: z.string().trim().min(1).max(20_000),
    baseSha: z.null().default(null),
    headSha: z.null().default(null),
    branch: z.null().default(null),
    prUrl: z.null().default(null),
  }).strict(),
]);

/** One result with the verification snapshot that belongs to that exact result. */
export const resultRecordSchema = z
  .object({
    result: resultSchema,
    verification: verificationSchema,
  })
  .strict();

export const stopRequestSchema = z
  .object({
    requested: z.boolean().default(false),
    at: z.number().int().nonnegative().nullable().default(null),
    reported: z.boolean().default(false),
    reportedAt: z.number().int().nonnegative().nullable().default(null),
    note: z.string().max(4000).nullable().default(null),
  })
  .strict();

export const progressUpdateSchema = z
  .object({
    updateId: z.string().min(1).max(200),
    kind: z.enum(['running', 'waiting_user', 'failed', 'stopped']),
    note: z.string().max(8000).default(''),
    processedThroughSeq: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
  })
  .strict();

export const roundSchema = z
  .object({
    roundId: uuidSchema,
    baseSha: shaSchema.nullable(),
    targetBranch: branchSchema.nullable(),
    remoteStatus: remoteStatusSchema,
    claimedAt: z.number().int().nonnegative().nullable().default(null),
    /** Repeating a claim returns this stored payload instead of creating a new claim. */
    claim: z
      .object({ claimedAt: z.number().int().nonnegative(), taskId: uuidSchema })
      .strict()
      .nullable()
      .default(null),
    stop: stopRequestSchema,
    lastProgress: progressUpdateSchema.nullable().default(null),
    /** Every progress report for this round, including late ones, so history is preserved. */
    progressHistory: z.array(progressUpdateSchema).max(500).default([]),
    /** The latest delivered result. */
    result: resultSchema.nullable().default(null),
    /**
     * Earlier results, each with its own verification snapshot; a newer result never erases them.
     * This list is intentionally unbounded: a delivered result is never silently dropped, so an old
     * commit stays queryable. Overflow is not truncated — use `task.history` for paged reads.
     */
    resultHistory: z.array(resultRecordSchema).default([]),
    /** The verification of the latest `result` only; history carries its own snapshots. */
    verification: verificationSchema,
    /** Why a queued round has not been dispatched yet (e.g. its base commit is unreachable). */
    dispatchBlocked: z
      .object({ reason: z.string().min(1).max(2000), at: z.number().int().nonnegative() })
      .strict()
      .nullable()
      .default(null),
    processedThroughSeq: z.number().int().nonnegative().default(0),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const taskSchema = z
  .object({
    id: uuidSchema,
    title: z.string().min(1).max(200),
    requirement: z.string().min(1).max(20_000),
    acceptance: z.string().max(20_000).default(''),
    connectionId: connectionIdSchema,
    workspaceId: z.string().min(1).max(200),
    mode: z.enum(['git', 'text']).default('git'),
    /** The workspace remote URL for Git tasks; text tasks have no repository binding. */
    repository: z.string().min(1).max(2000).nullable(),
    /** The remote name inside the bound workspace (origin, upstream, …). */
    remoteName: z.string().min(1).max(200).nullable().default('origin'),
    branch: branchSchema.nullable(),
    environmentHint: z.string().max(2000).default(''),
    workspaceRoot: z.string().nullable().default(null),
    localChanges: z.array(localReceiptSchema).default([]),
    provider: z.object({ cwd: z.string(), clientMessageIds: z.record(z.string(), z.string()) }).strict().nullable().default(null),
    currentRoundId: uuidSchema,
    rounds: z.array(roundSchema).min(1),
    messages: z.array(messageSchema),
    attachments: z.array(attachmentSchema).max(MAX_TASK_ATTACHMENTS).default([]),
    /** Latest message sequence, including dot messages; the next message takes seq + 1. */
    messageSeq: z.number().int().nonnegative().default(0),
    /** Latest user message sequence. Coverage is judged against this, not against dot messages. */
    userMessageSeq: z.number().int().nonnegative().default(0),
    /** Remote work status of the current round, mirrored for list views. */
    status: remoteStatusSchema,
    cancelRequested: z.boolean().default(false),
    operationIds: z.array(uuidSchema).max(200),
    revision: z.number().int().nonnegative().default(0),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((task, ctx) => {
    const text = task.mode === 'text';
    if ([task.repository, task.remoteName, task.branch].some(value => (value === null) !== text)
      || task.rounds.some(round => (round.baseSha === null) !== text || (round.targetBranch === null) !== text
        || [round.result, ...round.resultHistory.map(item => item.result)].some(result => result && result.kind !== task.mode))) {
      ctx.addIssue({ code: 'custom', message: 'Task mode must match repository, rounds and results' });
    }
  });

export const pendingEventSchema = z
  .object({
    eventId: uuidSchema,
    /** Event name, e.g. paseo.dot.task_changed. */
    name: z.enum(['paseo.dot.task_changed', 'paseo.dot.connection_test']),
    connectionId: connectionIdSchema,
    /** The subscription this event was matched to; deliveries carry it as X-MCP-Subscription-Id. */
    subscriptionId: z.string().min(1).max(200).nullable().default(null),
    data: z.record(z.string(), z.unknown()),
    status: deliveryStatusSchema,
    attempts: z.number().int().nonnegative().default(0),
    nextAttemptAt: z.number().int().nonnegative().default(0),
    lastError: z.string().max(2000).nullable().default(null),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export const subscriptionSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.enum(['paseo.dot.task_changed', 'paseo.dot.connection_test']),
    /** Subscription filter arguments, e.g. { connectionId }. */
    arguments: z.record(z.string(), z.unknown()),
    url: z.string().min(1).max(2000),
    /** Granted expiration in epoch ms; null means no expiration. */
    expiresAt: z.number().int().nonnegative().nullable().default(null),
    cursor: z.string().max(400).nullable().default(null),
    verifiedAt: z.number().int().nonnegative().nullable().default(null),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const connectionSchema = z
  .object({
    id: connectionIdSchema,
    name: z.string().min(1).max(200),
    /** Public HTTPS base the dot reaches; the tunnel URL. Empty until configured. */
    callbackBaseUrl: z.string().max(2000).default(''),
    subscriptions: z.array(subscriptionSchema).default([]),
    /** Successful callback verifications, keyed by subscription id. */
    callbackVerifications: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /** The live dot connection-test challenge (separate from protocol callback verification). */
    challenge: z
      .object({
        value: z.string().min(16).max(200),
        expiresAt: z.number().int().nonnegative(),
        used: z.boolean().default(false),
        /** The operation that asked for this challenge, so a replayed test returns the same one. */
        operationId: z.string().min(1).max(200).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    /** The dot called confirm_dot_connection with the live challenge. */
    dotVerifiedAt: z.number().int().nonnegative().nullable().default(null),
    lastCallbackAt: z.number().int().nonnegative().nullable().default(null),
    /** Bumped by connection.configure so a stale client cannot overwrite a newer edit. */
    revision: z.number().int().nonnegative().default(0),
  })
  .strict();

/** Duplicate ids return the stored result; the same id with different content is rejected. */
export const operationRecordSchema = z
  .object({
    hash: z.string().min(1).max(200),
    taskId: uuidSchema.nullable().default(null),
    /**
     * The exact response the first call returned, so a replay is byte-identical. There is no size
     * cap: a legitimate Task response carries the full verified diff and history, so a fixed limit
     * (previously 200 000 chars) would reject a real large result and block every later edit.
     */
    receipt: z.string().nullable().default(null),
    /**
     * False only for an id migrated from a version-1 archive: the identity is preserved so a replay
     * is refused (`operation-archived`), never re-executed, but its original response is gone and is
     * not reconstructed from mutable state.
     */
    replayable: z.boolean().default(true),
    /** When the operation was recorded, kept for diagnostics. */
    at: z.number().int().nonnegative().default(0),
  })
  .strict();

/**
 * A dot report (progress or result) keyed by updateId. The original outcome is stored alongside the
 * digest, so replaying an updateId returns exactly what the first call returned — never a later
 * head, coverage or status that has since changed. The digest still rejects a reused id whose body
 * differs. The response is uncapped for the same reason as a receipt.
 */
export const updateRecordSchema = z
  .object({
    hash: z.string().min(1).max(200),
    /** The exact outcome the first report returned; null only for records migrated from version 1. */
    response: z.string().nullable().default(null),
    at: z.number().int().nonnegative().default(0),
  })
  .strict();

/**
 * Operation and update dedup records live for as long as the store does. They are not pruned by a
 * fixed count, because forgetting an id while the task history is retained would let a replay
 * re-execute work (create a second task, run Git twice). Disk growth is bounded by real usage.
 */
export const dedupSchema = z
  .object({
    eventIds: z.record(z.string(), z.string()).default({}),
    updateIds: z.record(z.string(), updateRecordSchema).default({}),
    operations: z.record(z.string(), operationRecordSchema).default({}),
  })
  .strict();

/**
 * The current on-disk store version. Older files are migrated on load (see `migrateStoreFile`).
 * Version 1 predates per-result verification snapshots and the permanent operation log; version 2
 * stored a *partial* result outcome (`{coversLatest, applied}`) for an `updateId`, which version 3
 * replaces with the full `ResultOutcome`. Version 4 adds repository-free text tasks and typed
 * results; existing records default to Git.
 */
// v5: attachments; v6: native-provider bindings; v7: pinned local workspace and file-operation receipts.
// v8: chunked attachments up to 20 MiB and named local delivery paths.
export const STORE_VERSION = 8;

export const storeFileSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    connection: connectionSchema.nullable(),
    tasks: z.array(taskSchema),
    events: z.array(pendingEventSchema),
    dedup: dedupSchema,
  })
  .strict();

export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type RemoteStatus = z.infer<typeof remoteStatusSchema>;
export type VerifyStatus = z.infer<typeof verifyStatusSchema>;
export type CheckRecord = z.infer<typeof checkRecordSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type RoundResult = z.infer<typeof resultSchema>;
export type ResultRecord = z.infer<typeof resultRecordSchema>;
export type StopRequest = z.infer<typeof stopRequestSchema>;
export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;
export type Round = z.infer<typeof roundSchema>;
export type Task = z.infer<typeof taskSchema>;
export type PendingEvent = z.infer<typeof pendingEventSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Dedup = z.infer<typeof dedupSchema>;
export type OperationRecord = z.infer<typeof operationRecordSchema>;
export type UpdateRecord = z.infer<typeof updateRecordSchema>;
export type StoreFile = z.infer<typeof storeFileSchema>;

export function emptyVerification(): Verification {
  return verificationSchema.parse({ status: 'none' });
}

export function emptyStopRequest(): StopRequest {
  return stopRequestSchema.parse({});
}

/** The current round of a task. Every task always has at least one round. */
export function currentRound(task: Task): Round {
  const round = task.rounds.find(item => item.roundId === task.currentRoundId);
  if (!round) throw new Error('task has no current round');
  return round;
}

/** Remote statuses that still occupy one of the bridge's in-flight slots. */
export const OCCUPYING_STATUSES: readonly RemoteStatus[] = ['dispatched', 'claimed', 'running', 'waiting_user'];
/** Remote statuses that released their slot. */
export const RELEASED_STATUSES: readonly RemoteStatus[] = ['completed', 'failed', 'stopped'];

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * Upgrades an on-disk store from an older version to the current shape, without dropping data.
 *
 * Version 1 predates per-result verification snapshots (`resultHistory` held bare results), kept
 * update ids as a plain digest string, and pruned old operation records into a digest-only
 * `archive`. Version 2 stored a *partial* result outcome (`{coversLatest, applied}`) for an
 * `updateId`; version 3 stores the full outcome, so a version-2 partial is dropped to `null` (a
 * replay then returns a safe, unverified fallback rather than a malformed outcome).
 *
 * The migration is pure and defensive: anything it cannot interpret is left for the strict schema
 * to reject, and an old verification that cannot be reconstructed is marked unverified rather than
 * being paired with a `verified` status it never had.
 *
 * Crucially, every archived operation id is moved into the permanent operation log (marked
 * non-replayable) instead of being deleted. Deleting it would make a replay of that id look like a
 * brand-new operation and re-execute it — e.g. create a second task — which is exactly the
 * long-term idempotency the bridge promises.
 */
export function migrateStoreFile(input: unknown): { data: unknown; migrated: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { data: input, migrated: false };
  const file = input as Record<string, unknown>;
  if (file.version === STORE_VERSION) return { data: file, migrated: false };
  const out: Record<string, unknown> = { ...file, version: STORE_VERSION };
  const dedup = file.dedup && typeof file.dedup === 'object' && !Array.isArray(file.dedup)
    ? { ...(file.dedup as Record<string, unknown>) }
    : {};
  const updateIds = dedup.updateIds && typeof dedup.updateIds === 'object' && !Array.isArray(dedup.updateIds)
    ? (dedup.updateIds as Record<string, unknown>)
    : {};
  const migratedUpdates: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(updateIds)) {
    if (typeof value === 'string') migratedUpdates[id] = { hash: value, response: null, at: 0 };
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = { ...(value as Record<string, unknown>) };
      if (typeof record.response === 'string') record.response = upgradeUpdateResponse(record.response);
      migratedUpdates[id] = record;
    }
  }
  dedup.updateIds = migratedUpdates;
  // Version 1's digest-only archive is folded into the permanent operation log. An archived id keeps
  // its identity (so a replay is refused, not re-run) but has no receipt to return, so it is marked
  // non-replayable rather than dropped.
  const operations = dedup.operations && typeof dedup.operations === 'object' && !Array.isArray(dedup.operations)
    ? { ...(dedup.operations as Record<string, unknown>) }
    : {};
  const archive = dedup.archive && typeof dedup.archive === 'object' && !Array.isArray(dedup.archive)
    ? (dedup.archive as Record<string, unknown>)
    : {};
  for (const [id, value] of Object.entries(archive)) {
    if (operations[id] !== undefined) continue;
    const entry = migrateArchivedOperation(value);
    operations[id] = { hash: entry.hash, taskId: entry.taskId, receipt: null, replayable: false, at: entry.at };
  }
  dedup.operations = operations;
  delete dedup.archive;
  out.dedup = dedup;
  if (Array.isArray(file.tasks)) out.tasks = file.tasks.map(task => migrateTask(task));
  return { data: out, migrated: true };
}

/**
 * A version-2 update record stored a partial result outcome (`{coversLatest, applied}`) with no
 * verification. The current shape is the full `ResultOutcome`, so a partial cannot be replayed and
 * is dropped to `null`; a progress outcome (`{applied, reason}`) is still valid and kept as-is.
 */
function upgradeUpdateResponse(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if ('coversLatest' in record && !('verification' in record)) return null;
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Recovers what identity an archived (digest-only) operation still carries: hash, taskId and time. */
function migrateArchivedOperation(value: unknown): { hash: string; taskId: string | null; at: number } {
  if (typeof value === 'string' && value.trim()) return { hash: value.trim().slice(0, 200), taskId: null, at: 0 };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const rawHash = typeof record.hash === 'string' ? record.hash : typeof record.digest === 'string' ? record.digest : '';
    // A hash we cannot recover becomes a sentinel: the id is still remembered, so any replay is
    // refused as a content mismatch instead of being re-executed.
    const hash = rawHash.trim() ? rawHash.trim().slice(0, 200) : 'archived';
    const taskId = uuidSchema.safeParse(record.taskId).success ? (record.taskId as string) : null;
    const at = typeof record.at === 'number' && Number.isFinite(record.at) && record.at >= 0 ? Math.floor(record.at) : 0;
    return { hash, taskId, at };
  }
  return { hash: 'archived', taskId: null, at: 0 };
}

function migrateTask(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const task = { ...(input as Record<string, unknown>) };
  if (Array.isArray(task.rounds)) task.rounds = task.rounds.map(round => migrateRound(round));
  return task;
}

function migrateRound(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const round = { ...(input as Record<string, unknown>) };
  if (Array.isArray(round.resultHistory)) {
    round.resultHistory = round.resultHistory.map(entry => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'result' in (entry as Record<string, unknown>)) {
        return entry;
      }
      const result = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      const updateId = typeof result.updateId === 'string' ? result.updateId : null;
      const headSha = typeof result.headSha === 'string' && SHA_PATTERN.test(result.headSha) ? result.headSha : null;
      const coversLatest = typeof result.coversLatest === 'boolean' ? result.coversLatest : false;
      // The old result carried no verification snapshot, so it is recorded as unverified.
      return { result: entry, verification: { status: 'none', updateId, headSha, coversLatest } };
    });
  }
  return round;
}
