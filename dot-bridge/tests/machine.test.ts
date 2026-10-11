import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  claimRound,
  createNextRound,
  createTask,
  currentRound,
  inFlightCount,
  planDispatch,
  recomputeCoverage,
  reduceProgress,
  reduceResult,
  requestCancel,
  retryRound,
  withDispatch,
  type CreateTaskInput,
} from '../shared/machine';
import { emptyVerification } from '../shared/schema';

const CONNECTION = 'a'.repeat(32);
const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);

function baseInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    connectionId: CONNECTION,
    workspaceId: 'ws-1',
    repository: 'https://github.com/acme/repo.git',
    remoteName: 'origin',
    branch: `dot/${id}`,
    environmentHint: 'my-env',
    title: 'Fix the thing',
    requirement: 'Change note.txt',
    acceptance: 'tests pass',
    baseSha: BASE,
    targetBranch: 'main',
    roundId: randomUUID(),
    at: 1000,
    ...overrides,
  };
}

function makeTask() {
  const input = baseInput();
  const task = createTask(input);
  return { task, input };
}

/** A dispatched, claimed task is the only shape that may report progress or a result. */
function dispatchedClaimed() {
  const dispatched = withDispatch(makeTask().task, 3000);
  return claimRound(dispatched, CONNECTION, dispatched.currentRoundId, 3100).task;
}

describe('task creation', () => {
  it('starts queued with one round and one user requirement message', () => {
    const { task } = makeTask();
    assert.equal(task.status, 'queued');
    assert.equal(task.messageSeq, 1);
    assert.equal(task.userMessageSeq, 1);
    assert.equal(task.rounds.length, 1);
    assert.equal(task.messages[0].author, 'user');
    assert.equal(task.messages[0].delivery, 'pending');
    assert.equal(task.messages[0].roundId, task.currentRoundId);
    assert.equal(currentRound(task).remoteStatus, 'queued');
  });
});

describe('in-flight cap', () => {
  it('dispatches only up to the cap and leaves the third task queued', () => {
    const tasks = [makeTask().task, makeTask().task, makeTask().task];
    const plan = planDispatch(tasks, 2, true);
    assert.equal(plan.dispatch.length, 2);
    assert.equal(plan.queuedByConnection.length, 1);
    assert.equal(inFlightCount(tasks), 0);
  });

  it('dispatches nothing while the connection is not verified', () => {
    const tasks = [makeTask().task, makeTask().task];
    const plan = planDispatch(tasks, 2, false);
    assert.equal(plan.dispatch.length, 0);
    assert.equal(plan.queuedByConnection.length, 2);
  });

  it('occupies a slot from the persisted dispatch intent', () => {
    const task = withDispatch(makeTask().task, 2000);
    assert.equal(currentRound(task).remoteStatus, 'dispatched');
    assert.equal(inFlightCount([task]), 1);
  });
});

describe('claim', () => {
  it('is idempotent and refuses a queued task', () => {
    const queued = makeTask().task;
    assert.throws(() => claimRound(queued, CONNECTION, queued.currentRoundId, 3000), /claim-rejected/);
    const dispatched = withDispatch(queued, 3000);
    const first = claimRound(dispatched, CONNECTION, dispatched.currentRoundId, 3100);
    assert.equal(first.created, true);
    const second = claimRound(first.task, CONNECTION, first.task.currentRoundId, 3200);
    assert.equal(second.created, false);
    assert.deepEqual(second.claim, first.claim);
  });

  it('refuses a task that belongs to another connection', () => {
    const dispatched = withDispatch(makeTask().task, 3000);
    assert.throws(() => claimRound(dispatched, 'b'.repeat(32), dispatched.currentRoundId, 3100), /claim-unavailable/);
  });
});

describe('cancel and stop', () => {
  it('cancels a queued task locally without a stop report', () => {
    const canceled = requestCancel(makeTask().task, 4000);
    assert.equal(currentRound(canceled).remoteStatus, 'stopped');
    assert.equal(canceled.cancelRequested, true);
    assert.equal(currentRound(canceled).stop.requested, true);
    assert.equal(currentRound(canceled).stop.reported, false);
  });

  it('records a stop request for a dispatched task', () => {
    const dispatched = withDispatch(makeTask().task, 4000);
    const stopped = requestCancel(dispatched, 4100);
    assert.equal(currentRound(stopped).remoteStatus, 'dispatched');
    assert.equal(currentRound(stopped).stop.requested, true);
  });
});

describe('progress and result', () => {
  it('requires a claim before progress or a result', () => {
    const dispatched = withDispatch(makeTask().task, 5000);
    assert.throws(
      () => reduceProgress(dispatched, { roundId: dispatched.currentRoundId, updateId: 'u0', kind: 'running', note: '', processedThroughSeq: 1, at: 5100 }),
      /claim-required/,
    );
    assert.throws(
      () => reduceResult(dispatched, { roundId: dispatched.currentRoundId, baseSha: BASE, headSha: HEAD, branch: dispatched.branch, summary: '', checks: [], prUrl: null, reportedAt: 5100, updateId: 'u0', processedThroughSeq: 1 }),
      /claim-required/,
    );
  });

  it('marks a result that does not cover the latest message', () => {
    let task = dispatchedClaimed();
    // A second user message arrives while the round is running.
    task = { ...task, messages: [...task.messages, { ...task.messages[0], seq: 2 }], messageSeq: 2, userMessageSeq: 2 };
    const reduced = reduceResult(task, {
      roundId: task.currentRoundId,
      baseSha: BASE,
      headSha: HEAD,
      branch: task.branch,
      summary: 'done',
      checks: [],
      prUrl: null,
      reportedAt: 6000,
      updateId: 'u1',
      processedThroughSeq: 1,
    });
    assert.equal(reduced.applied, true);
    assert.equal(reduced.coversLatest, false);
    assert.equal(currentRound(reduced.task).remoteStatus, 'completed');
    assert.equal(currentRound(reduced.task).verification.status, 'verifying');
    assert.equal(currentRound(reduced.task).verification.updateId, 'u1');
  });

  it('keeps a report for an older round in that round history, not the current round', () => {
    const claimed = dispatchedClaimed();
    const olderRoundId = claimed.currentRoundId;
    const newRoundId = randomUUID();
    const next = { ...claimed, currentRoundId: newRoundId, rounds: [...claimed.rounds, { ...claimed.rounds[0], roundId: newRoundId }] };
    const reduced = reduceResult(next, {
      roundId: olderRoundId,
      baseSha: BASE,
      headSha: HEAD,
      branch: claimed.branch,
      summary: 'stale',
      checks: [],
      prUrl: null,
      reportedAt: 6000,
      updateId: 'u2',
      processedThroughSeq: 1,
    });
    assert.equal(reduced.applied, false);
    assert.equal(reduced.reason, 'history');
    assert.equal(currentRound(reduced.task).result, null);
  });

  it('records a stopped report from progress', () => {
    const claimed = dispatchedClaimed();
    const outcome = reduceProgress(claimed, { roundId: claimed.currentRoundId, updateId: 'u3', kind: 'stopped', note: 'stopped', processedThroughSeq: 1, at: 5100 });
    assert.equal(outcome.applied, true);
    assert.equal(currentRound(outcome.task).remoteStatus, 'stopped');
    assert.equal(currentRound(outcome.task).stop.reported, true);
  });

  it('does not revive a terminal round with a late running report', () => {
    let task = dispatchedClaimed();
    task = reduceResult(task, { roundId: task.currentRoundId, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: '', checks: [], prUrl: null, reportedAt: 6000, updateId: 'u4', processedThroughSeq: 1 }).task;
    const late = reduceProgress(task, { roundId: task.currentRoundId, updateId: 'u5', kind: 'running', note: 'still going', processedThroughSeq: 1, at: 6100 });
    assert.equal(late.applied, false);
    assert.equal(late.reason, 'terminal');
    assert.equal(currentRound(late.task).remoteStatus, 'completed');
  });

  it('does not revive a completed round with a late waiting_user report, but keeps it in history', () => {
    let task = dispatchedClaimed();
    task = reduceResult(task, { roundId: task.currentRoundId, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: '', checks: [], prUrl: null, reportedAt: 6000, updateId: 'u6', processedThroughSeq: 1 }).task;
    const late = reduceProgress(task, { roundId: task.currentRoundId, updateId: 'u7', kind: 'waiting_user', note: 'need input', processedThroughSeq: 1, at: 6100 });
    assert.equal(late.applied, false);
    assert.equal(late.reason, 'terminal');
    // waiting_user must not occupy a slot after the round already completed.
    assert.equal(currentRound(late.task).remoteStatus, 'completed');
    assert.equal(currentRound(late.task).progressHistory.length, 1);
  });

  it('anchors coverage to the result own seq, not a later read report', () => {
    let task = dispatchedClaimed();
    // A second user message exists; the result only covered seq 1.
    task = { ...task, messages: [...task.messages, { ...task.messages[0], seq: 2 }], messageSeq: 2, userMessageSeq: 2 };
    task = reduceResult(task, { roundId: task.currentRoundId, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, reportedAt: 6000, updateId: 'u8', processedThroughSeq: 1 }).task;
    assert.equal(currentRound(task).result?.coversLatest, false);
    // A read report raises the round's processedThroughSeq, but coverage must not rise with it.
    const progressed = reduceProgress(task, { roundId: task.currentRoundId, updateId: 'u9', kind: 'running', note: '', processedThroughSeq: 2, at: 6100 }).task;
    assert.equal(currentRound(progressed).processedThroughSeq, 2);
    const recomputed = recomputeCoverage(progressed);
    assert.equal(currentRound(recomputed).result?.coversLatest, false);
    assert.equal(currentRound(recomputed).verification.coversLatest, false);
  });

  it('clamps a reported sequence to the messages that exist', () => {
    const task = dispatchedClaimed();
    const reduced = reduceResult(task, { roundId: task.currentRoundId, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'done', checks: [], prUrl: null, reportedAt: 6000, updateId: 'u10', processedThroughSeq: 999 });
    assert.equal(currentRound(reduced.task).result?.processedThroughSeq, task.messageSeq);
  });
});

describe('retry', () => {
  it('restarts a failed round with a new roundId, keeping the same branch and fixed base', () => {
    let task = dispatchedClaimed();
    task = reduceProgress(task, { roundId: task.currentRoundId, updateId: 'u-fail', kind: 'failed', note: 'quota', processedThroughSeq: 1, at: 5100 }).task;
    assert.equal(currentRound(task).remoteStatus, 'failed');
    const oldRoundId = task.currentRoundId;
    const newRoundId = randomUUID();
    const retried = retryRound(task, oldRoundId, newRoundId, 6000);
    assert.equal(retried.currentRoundId, newRoundId);
    assert.notEqual(newRoundId, oldRoundId);
    assert.equal(currentRound(retried).remoteStatus, 'queued');
    assert.equal(currentRound(retried).claim, null);
    assert.equal(currentRound(retried).baseSha, BASE);
    assert.equal(retried.branch, task.branch);
    // The previous attempt is kept whole as its own round.
    assert.equal(retried.rounds.length, 2);
    assert.equal(retried.rounds.find(round => round.roundId === oldRoundId)!.remoteStatus, 'failed');
  });

  it('refuses to retry an in-flight or verified round', () => {
    const claimed = dispatchedClaimed();
    assert.throws(() => retryRound(claimed, claimed.currentRoundId, randomUUID(), 6000), /round-open/);
  });

  it('clears the local cancel flag so a canceled queued task can be retried and dispatched', () => {
    const canceled = requestCancel(makeTask().task, 4000);
    assert.equal(canceled.cancelRequested, true);
    assert.equal(currentRound(canceled).remoteStatus, 'stopped');
    const retried = retryRound(canceled, canceled.currentRoundId, randomUUID(), 5000);
    assert.equal(retried.cancelRequested, false);
    assert.equal(currentRound(retried).remoteStatus, 'queued');
  });

  it('fences a late report from the previous attempt to its own history, not the new round', () => {
    let task = dispatchedClaimed();
    const oldRoundId = task.currentRoundId;
    task = reduceProgress(task, { roundId: oldRoundId, updateId: 'u-fail', kind: 'failed', note: 'quota', processedThroughSeq: 1, at: 5100 }).task;
    const retried = retryRound(task, oldRoundId, randomUUID(), 6000);
    // A late result that names the OLD round must not complete the new work.
    const late = reduceResult(retried, {
      roundId: oldRoundId,
      baseSha: BASE,
      headSha: HEAD,
      branch: retried.branch,
      summary: 'stale',
      checks: [],
      prUrl: null,
      reportedAt: 7000,
      updateId: 'u-late',
      processedThroughSeq: 1,
    });
    assert.equal(late.applied, false);
    assert.equal(late.reason, 'history');
    assert.equal(currentRound(late.task).roundId, retried.currentRoundId);
    assert.equal(currentRound(late.task).result, null);
    assert.equal(currentRound(late.task).remoteStatus, 'queued');
  });

  it('keeps a late old-round report as history with an unverified snapshot', () => {
    let task = dispatchedClaimed();
    task = reduceResult(task, { roundId: task.currentRoundId, baseSha: BASE, headSha: HEAD, branch: task.branch, summary: 'first', checks: [], prUrl: null, reportedAt: 6000, updateId: 'u1', processedThroughSeq: 1 }).task;
    const verified: typeof task = {
      ...task,
      rounds: task.rounds.map(round => round.roundId === task.currentRoundId ? { ...round, verification: { ...round.verification, status: 'verified' as const, verifiedHead: HEAD } } : round),
    };
    const olderRoundId = verified.currentRoundId;
    const newRoundId = randomUUID();
    const withNext = { ...verified, currentRoundId: newRoundId, rounds: [...verified.rounds, { ...verified.rounds[0], roundId: newRoundId, verification: emptyVerification() }] };
    const late = reduceResult(withNext, { roundId: olderRoundId, baseSha: BASE, headSha: HEAD, branch: verified.branch, summary: 'late', checks: [], prUrl: null, reportedAt: 7000, updateId: 'u2', processedThroughSeq: 1 });
    const old = late.task.rounds.find(round => round.roundId === olderRoundId)!;
    assert.equal(old.result?.updateId, 'u2');
    assert.notEqual(old.verification.status, 'verified');
    assert.equal(old.resultHistory.length, 1);
    assert.equal(old.resultHistory[0].result.updateId, 'u1');
    assert.equal(old.resultHistory[0].verification.status, 'verified');
  });
});

describe('next round', () => {
  it('requires a verified head and continues the same branch', () => {
    let task = withDispatch(makeTask().task, 5000);
    assert.throws(() => createNextRound(task, randomUUID(), 6000), /round-open/);
    const round = currentRound(task);
    task = {
      ...task,
      rounds: task.rounds.map(item => item.roundId === round.roundId
        ? { ...item, remoteStatus: 'completed' as const, verification: { ...emptyVerification(), status: 'verified' as const, verifiedHead: HEAD } }
        : item),
    };
    const next = createNextRound(task, randomUUID(), 6000);
    assert.equal(next.rounds.length, 2);
    assert.equal(currentRound(next).baseSha, HEAD);
    assert.equal(currentRound(next).remoteStatus, 'queued');
    assert.equal(next.branch, task.branch);
  });
});
