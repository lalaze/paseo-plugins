/**
 * Pure state transitions for dot-bridge. No I/O lives here, so the queue rules, the round
 * lifecycle, claim idempotency and coverage are unit-testable without a daemon or a git remote.
 */
import { dotBridgeError } from './errors';
import {
  emptyStopRequest,
  emptyVerification,
  OCCUPYING_STATUSES,
  currentRound,
  messageSchema,
  roundSchema,
  resultSchema,
  taskSchema,
  type Message,
  type ProgressUpdate,
  type RemoteStatus,
  type Round,
  type RoundResult,
  type Task,
  type Verification,
} from './schema';

export interface CreateTaskInput {
  id: string;
  connectionId: string;
  workspaceId: string;
  mode?: 'git' | 'text';
  repository: string | null;
  remoteName: string | null;
  branch: string | null;
  environmentHint: string;
  title: string;
  requirement: string;
  acceptance: string;
  baseSha: string | null;
  targetBranch: string | null;
  roundId: string;
  at: number;
}

export function createTask(input: CreateTaskInput): Task {
  const message = messageSchema.parse({
    seq: 1,
    roundId: input.roundId,
    author: 'user',
    kind: 'requirement',
    body: input.requirement,
    at: input.at,
    delivery: 'pending',
  });
  const round = roundSchema.parse({
    roundId: input.roundId,
    baseSha: input.baseSha,
    targetBranch: input.targetBranch,
    remoteStatus: 'queued',
    stop: emptyStopRequest(),
    verification: emptyVerification(),
    createdAt: input.at,
    updatedAt: input.at,
  });
  return taskSchema.parse({
    id: input.id,
    title: input.title,
    requirement: input.requirement,
    acceptance: input.acceptance,
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    mode: input.mode ?? 'git',
    repository: input.repository,
    remoteName: input.remoteName,
    branch: input.branch,
    environmentHint: input.environmentHint,
    currentRoundId: input.roundId,
    rounds: [round],
    messages: [message],
    messageSeq: 1,
    userMessageSeq: 1,
    status: 'queued',
    operationIds: [],
    createdAt: input.at,
    updatedAt: input.at,
  });
}

/** A round occupies a bridge in-flight slot from the persisted dispatch intent until it is released. */
export function occupiesSlot(round: Round): boolean {
  return OCCUPYING_STATUSES.includes(round.remoteStatus);
}

export function inFlightCount(tasks: readonly Task[]): number {
  return tasks.filter(task => occupiesSlot(currentRound(task))).length;
}

/** Tasks the scheduler may dispatch next, oldest first. Queue order is creation order. */
export function dispatchOrder(tasks: readonly Task[]): Task[] {
  return tasks
    .filter(task => currentRound(task).remoteStatus === 'queued' && !task.cancelRequested)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/**
 * Dispatch up to `maxInFlight` queued tasks. Returns the ids that changed and the ids left queued
 * because the connection is not verified (they must not show as running).
 */
export function planDispatch(
  tasks: readonly Task[],
  maxInFlight: number,
  connectionReady: boolean,
): { dispatch: string[]; queuedByConnection: string[] } {
  const occupied = inFlightCount(tasks);
  const free = Math.max(0, maxInFlight - occupied);
  const candidates = dispatchOrder(tasks);
  if (!connectionReady) return { dispatch: [], queuedByConnection: candidates.map(task => task.id) };
  return { dispatch: candidates.slice(0, free).map(task => task.id), queuedByConnection: candidates.slice(free).map(task => task.id) };
}

export function withDispatch(task: Task, at: number): Task {
  const round = currentRound(task);
  if (round.remoteStatus !== 'queued') throw dotBridgeError('task-rejected', round.remoteStatus);
  const nextRound: Round = { ...round, remoteStatus: 'dispatched', dispatchBlocked: null, updatedAt: at };
  return replaceRound(task, nextRound, at, 'dispatched');
}

/** Records why a queued round is not being dispatched (e.g. its base commit is unreachable). */
export function markDispatchBlocked(task: Task, reason: string, at: number): Task {
  const round = currentRound(task);
  if (round.remoteStatus !== 'queued') return task;
  const nextRound: Round = { ...round, dispatchBlocked: { reason, at }, updatedAt: at };
  return replaceRoundRaw(task, nextRound, at);
}

/** Clears a stale dispatch-blocked note once the round is no longer queued or is being dispatched. */
export function clearDispatchBlocked(task: Task, at: number): Task {
  const round = currentRound(task);
  if (round.dispatchBlocked === null) return task;
  return replaceRoundRaw(task, { ...round, dispatchBlocked: null, updatedAt: at }, at);
}

export interface ClaimOutcome {
  task: Task;
  claim: { claimedAt: number; taskId: string };
  created: boolean;
}

/**
 * Atomic claim. Only the current round of a dispatched task for this connection may be claimed.
 * Repeating the claim — before or after the dot started reporting, or even after the round reached
 * a terminal status — returns the stored claim, so a retried claim is never rejected. A queued round
 * is rejected so the in-flight cap cannot be bypassed.
 */
export function claimRound(task: Task, connectionId: string, roundId: string, at: number): ClaimOutcome {
  if (task.connectionId !== connectionId) throw dotBridgeError('claim-unavailable');
  if (roundId !== task.currentRoundId) throw dotBridgeError('claim-unavailable', 'not the current round');
  const round = currentRound(task);
  // A stored claim is the original outcome; return it whatever the round's current status is.
  if (round.claim) return { task, claim: round.claim, created: false };
  if (round.remoteStatus !== 'dispatched') throw dotBridgeError('claim-rejected', round.remoteStatus);
  const claim = { claimedAt: at, taskId: task.id };
  const nextRound: Round = { ...round, remoteStatus: 'claimed', claim, claimedAt: at, dispatchBlocked: null, updatedAt: at };
  return { task: replaceRound(task, nextRound, at, 'claimed'), claim, created: true };
}

const PROGRESS_STATUS: Record<ProgressUpdate['kind'], RemoteStatus> = {
  running: 'running',
  waiting_user: 'waiting_user',
  failed: 'failed',
  stopped: 'stopped',
};

export interface ProgressInput extends ProgressUpdate {
  roundId: string;
}

export interface ProgressOutcome {
  task: Task;
  applied: boolean;
  reason: 'ok' | 'history' | 'terminal';
}

/**
 * Progress requires a claimed round. A report for an older round, or any non-terminal report after
 * the round reached a terminal status, is stored in that round's history and never revives work.
 * Only a new round may restart work on a task.
 */
export function reduceProgress(task: Task, input: ProgressInput): ProgressOutcome {
  const round = task.rounds.find(item => item.roundId === input.roundId);
  if (!round) throw dotBridgeError('round-missing');
  if (!round.claim) throw dotBridgeError('claim-required', 'progress before claim');
  const isCurrent = round.roundId === task.currentRoundId;
  const terminal = round.remoteStatus === 'completed' || round.remoteStatus === 'failed' || round.remoteStatus === 'stopped';
  const historyOnly = !isCurrent || terminal;
  const status = historyOnly ? round.remoteStatus : PROGRESS_STATUS[input.kind];

  const processed = clampSeq(input.processedThroughSeq, task.messageSeq);
  let next: Task = task;
  if (input.note.trim()) {
    const kind = input.kind === 'waiting_user' ? 'question' : input.kind === 'failed' ? 'error' : 'progress';
    next = appendDotMessage(next, round.roundId, kind, input.note, input.at, input.updateId);
  }
  const stop = input.kind === 'stopped'
    ? { ...round.stop, reported: true, reportedAt: input.at, note: input.note || round.stop.note }
    : round.stop;
  const nextRound: Round = {
    ...round,
    remoteStatus: status,
    lastProgress: { updateId: input.updateId, kind: input.kind, note: input.note, processedThroughSeq: processed, at: input.at },
    progressHistory: [...round.progressHistory, { updateId: input.updateId, kind: input.kind, note: input.note, processedThroughSeq: processed, at: input.at }].slice(-500),
    processedThroughSeq: Math.max(round.processedThroughSeq, processed),
    stop,
    updatedAt: input.at,
  };
  const replaced = replaceRoundRaw(next, nextRound, input.at);
  if (historyOnly) return { task: replaced, applied: false, reason: isCurrent ? 'terminal' : 'history' };
  return { task: { ...replaced, status }, applied: true, reason: 'ok' };
}

export interface ResultInput {
  kind?: 'git' | 'text';
  roundId: string;
  baseSha: string | null;
  headSha: string | null;
  branch: string | null;
  summary: string;
  checks: RoundResult['checks'];
  prUrl: string | null;
  reportedAt: number;
  updateId: string;
  processedThroughSeq: number;
}

export interface ResultOutcome {
  task: Task;
  applied: boolean;
  reason: 'ok' | 'history';
  /** True when every user message that existed at submit time was covered. */
  coversLatest: boolean;
}

/**
 * A submitted result completes the current round. It is saved even when it does not cover the
 * latest user message, but `coversLatest` stays false so the UI cannot call the current
 * requirement finished; a fresh task_changed event lets the dot read the remaining messages.
 * A result for an older round is kept in that round's history.
 */
export function reduceResult(task: Task, input: ResultInput): ResultOutcome {
  const round = task.rounds.find(item => item.roundId === input.roundId);
  if (!round) throw dotBridgeError('round-missing');
  if (!round.claim) throw dotBridgeError('claim-required', 'result before claim');
  // Coverage is judged by this result's own confirmation seq, never by a later read report.
  const processed = clampSeq(input.processedThroughSeq, task.messageSeq);
  const coversLatest = processed >= task.userMessageSeq;
  const result = resultSchema.parse({
    kind: input.kind ?? 'git',
    baseSha: input.baseSha,
    headSha: input.headSha,
    branch: input.branch,
    summary: input.summary,
    checks: input.checks,
    prUrl: input.prUrl,
    reportedAt: input.reportedAt,
    updateId: input.updateId,
    processedThroughSeq: processed,
    coversLatest,
  });
  if (result.kind !== task.mode) throw dotBridgeError('task-rejected', 'result kind does not match task mode');
  if (round.roundId !== task.currentRoundId || round.stop.localClosedAt !== null) {
    // A late report for an older round is history only. Keep the previous result+verification pair
    // as its own snapshot, then record the new result with a fresh, unverified verification, so a
    // `verified` status can never be paired with a different updateId or head.
    const history = round.result
      ? [...round.resultHistory, { result: round.result, verification: round.verification }]
      : round.resultHistory;
    const verification: Verification = { ...emptyVerification(), updateId: input.updateId, headSha: input.headSha };
    const nextRound: Round = {
      ...round,
      result,
      resultHistory: history,
      verification,
      processedThroughSeq: Math.max(round.processedThroughSeq, processed),
      updatedAt: input.reportedAt,
    };
    return { task: replaceRoundRaw(task, nextRound, input.reportedAt), applied: false, reason: 'history', coversLatest };
  }
  const verification: Verification = {
    ...emptyVerification(),
    status: result.kind === 'text' ? 'none' : 'verifying',
    coversLatest,
    updateId: input.updateId,
    headSha: input.headSha,
  };
  const history = round.result
    ? [...round.resultHistory, { result: round.result, verification: round.verification }]
    : round.resultHistory;
  const nextRound: Round = {
    ...round,
    remoteStatus: 'completed',
    result,
    resultHistory: history,
    verification,
    processedThroughSeq: Math.max(round.processedThroughSeq, processed),
    updatedAt: input.reportedAt,
  };
  return { task: replaceRound(task, nextRound, input.reportedAt, 'completed'), applied: true, reason: 'ok', coversLatest };
}

/** A sequence number is clamped to the messages that actually exist, so a report cannot inflate it. */
function clampSeq(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), Math.max(max, 0));
}

export function markVerification(task: Task, roundId: string, verification: Verification, at: number): Task {
  const round = task.rounds.find(item => item.roundId === roundId);
  if (!round) throw dotBridgeError('round-missing');
  return replaceRoundRaw(task, { ...round, verification, updatedAt: at }, at);
}

/**
 * Recomputes whether the current round's result still covers every user message. A read report does
 * not raise an existing result's coverage: only a newer user message can lower it, and only a
 * result that itself covered that message can be "covering latest".
 */
export function recomputeCoverage(task: Task): Task {
  const round = currentRound(task);
  if (!round.result) return task;
  const covers = round.result.processedThroughSeq >= task.userMessageSeq;
  if (round.verification.coversLatest === covers && round.result.coversLatest === covers) return task;
  const result = { ...round.result, coversLatest: covers };
  const nextRound: Round = { ...round, result, verification: { ...round.verification, coversLatest: covers } };
  return replaceRoundRaw(task, nextRound, task.updatedAt);
}

/** Cancel before a claim locally; claimed work keeps its slot until Dot reports the stop. */
export function requestCancel(task: Task, at: number): Task {
  const round = currentRound(task);
  if (round.remoteStatus === 'queued' || (round.remoteStatus === 'dispatched' && !round.claim && round.claimedAt === null)) {
    const nextRound: Round = { ...round, remoteStatus: 'stopped', stop: { ...round.stop, requested: true, at: round.stop.at ?? at, note: round.stop.note ?? 'canceled locally' }, updatedAt: at };
    return { ...replaceRound(task, nextRound, at, 'stopped'), cancelRequested: true };
  }
  if (occupiesSlot(round)) {
    const nextRound: Round = { ...round, stop: { ...round.stop, requested: true, at }, updatedAt: at };
    return replaceRound(task, nextRound, at, round.remoteStatus);
  }
  throw dotBridgeError('stop-rejected', round.remoteStatus);
}

/** Explicit local recovery fences the round without claiming that remote execution stopped. */
export function closeLocalRound(task: Task, at: number): Task {
  const round = currentRound(task);
  if (task.mode !== 'text' || !round.claim || !round.stop.requested || !occupiesSlot(round)) throw dotBridgeError('stop-rejected', 'Request stop on an active claimed text round first');
  const nextRound: Round = { ...round, remoteStatus: 'stopped', stop: { ...round.stop, localClosedAt: at }, updatedAt: at };
  return replaceRound(task, nextRound, at, 'stopped');
}

export function canStartNextRound(task: Task): boolean {
  const round = currentRound(task);
  if (task.mode === 'text') return round.remoteStatus === 'completed';
  return (round.remoteStatus === 'completed' || round.remoteStatus === 'failed' || round.remoteStatus === 'stopped')
    && round.verification.status === 'verified'
    && round.verification.verifiedHead !== null;
}

/** Git rounds continue from a verified head; text rounds carry no Git binding. */
export function createNextRound(task: Task, roundId: string, at: number): Task {
  if (!canStartNextRound(task)) throw dotBridgeError('round-open');
  const round = currentRound(task);
  const head = round.verification.verifiedHead;
  if (!head && task.mode === 'git') throw dotBridgeError('round-open');
  const next: Round = roundSchema.parse({
    roundId,
    baseSha: head,
    targetBranch: round.targetBranch,
    remoteStatus: 'queued',
    stop: emptyStopRequest(),
    verification: emptyVerification(),
    createdAt: at,
    updatedAt: at,
  });
  return {
    ...task,
    currentRoundId: roundId,
    rounds: [...task.rounds, next],
    status: 'queued',
    updatedAt: at,
    revision: task.revision + 1,
  };
}

/**
 * Restarts work on the same task, branch and fixed base after the previous attempt failed, stopped
 * or produced an unverified delivery. A *new* roundId fences the new attempt from the old one: a
 * late report that names the old round can only land in that round's history, so it can never close
 * the new work or release its slot. The local cancel flag is cleared, so a queued task canceled
 * locally can be explicitly retried and dispatched again. Never creates a replacement task and never
 * invents a new base.
 */
export function retryRound(task: Task, roundId: string, newRoundId: string, at: number): Task {
  if (roundId !== task.currentRoundId) throw dotBridgeError('round-missing', 'not the current round');
  const round = currentRound(task);
  if (occupiesSlot(round)) throw dotBridgeError('round-open', 'round is still in flight');
  const retryable = round.remoteStatus === 'failed'
    || round.remoteStatus === 'stopped'
    || (task.mode === 'git' && round.remoteStatus === 'completed' && round.verification.status !== 'verified');
  if (!retryable) throw dotBridgeError('retry-unavailable', round.remoteStatus);
  // The previous attempt is kept whole (result and its verification snapshot) as a past round.
  const next: Round = roundSchema.parse({
    roundId: newRoundId,
    baseSha: round.baseSha,
    targetBranch: round.targetBranch,
    remoteStatus: 'queued',
    stop: emptyStopRequest(),
    verification: emptyVerification(),
    createdAt: at,
    updatedAt: at,
  });
  return {
    ...task,
    currentRoundId: newRoundId,
    rounds: [...task.rounds, next],
    status: 'queued',
    cancelRequested: false,
    updatedAt: at,
    revision: task.revision + 1,
  };
}

export function appendUserMessage(task: Task, body: string, kind: Message['kind'], at: number): Task {
  const seq = task.messageSeq + 1;
  const message = messageSchema.parse({ seq, roundId: task.currentRoundId, author: 'user', kind, body, at, delivery: 'pending' });
  const next: Task = { ...task, messages: [...task.messages, message], messageSeq: seq, userMessageSeq: seq, updatedAt: at, revision: task.revision + 1 };
  // A new user message invalidates coverage of any result already delivered for this round.
  return recomputeCoverage(next);
}

export function appendDotMessage(task: Task, roundId: string, kind: Message['kind'], body: string, at: number, updateId: string | null): Task {
  const seq = task.messageSeq + 1;
  const message = messageSchema.parse({ seq, roundId, author: 'dot', kind, body, at, delivery: 'delivered', updateId });
  return { ...task, messages: [...task.messages, message], messageSeq: seq, updatedAt: at };
}

export function markDelivery(task: Task, seq: number, delivery: Message['delivery'], error: string | null, at: number): Task {
  const messages = task.messages.map(message =>
    message.seq === seq && message.author === 'user' ? { ...message, delivery, deliveryError: error } : message,
  );
  return { ...task, messages, updatedAt: at };
}

export function recordOperation(task: Task, operationId: string, at: number): Task {
  if (task.operationIds.includes(operationId)) return task;
  return { ...task, operationIds: [...task.operationIds, operationId].slice(-200), revision: task.revision + 1, updatedAt: at };
}

function replaceRound(task: Task, round: Round, at: number, status: RemoteStatus): Task {
  const rounds = task.rounds.map(item => (item.roundId === round.roundId ? round : item));
  return { ...task, rounds, status, updatedAt: at, revision: task.revision + 1 };
}

/** Replaces a round without touching the task's mirrored status or revision (history-only edits). */
function replaceRoundRaw(task: Task, round: Round, at: number): Task {
  const rounds = task.rounds.map(item => (item.roundId === round.roundId ? round : item));
  return { ...task, rounds, updatedAt: at };
}

export { currentRound };
