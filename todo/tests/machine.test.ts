import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recoverExecution, reduceCollaboration, reducePermission, reduceTurn, type TurnKind } from '../shared/machine';
import { reviewsMatch, type ReviewBinding } from '../shared/schema';

const review: ReviewBinding = {
  resultCommit: 'a'.repeat(40), resultTree: 'b'.repeat(40), targetBranch: 'main',
  targetHead: 'c'.repeat(40), turnId: 'turn-1', operationId: '11111111-1111-4111-8111-111111111111',
};

describe('task machine', () => {
  it('ends a turn only from completed, failed, or canceled', () => {
    assert.equal(reduceTurn('running', 'completed'), 'awaiting_review');
    assert.equal(reduceTurn('running', 'failed'), 'failed');
    assert.equal(reduceTurn('needs_attention', 'canceled'), 'canceled');
    assert.equal(reduceTurn('canceling', 'completed'), 'canceled');
    assert.equal(reduceTurn('awaiting_review', 'completed'), null);
    assert.equal(reduceTurn('queued', 'completed'), null);
    const kinds: TurnKind[] = ['completed', 'failed', 'canceled'];
    assert.deepEqual(kinds, ['completed', 'failed', 'canceled']);
    assert.equal(reducePermission('running', true), 'needs_attention');
    assert.equal(reducePermission('needs_attention', false), 'running');
    assert.equal(reducePermission('needs_attention', true), 'needs_attention');
  });

  it('never asks recovery to dispatch again', () => {
    const inputs = [
      { hasOperation: false, exists: false, active: false, permission: false, gatewayFailed: false },
      { hasOperation: true, exists: false, active: false, permission: false, gatewayFailed: false },
      { hasOperation: true, exists: true, active: false, permission: false, gatewayFailed: false },
      { hasOperation: true, exists: true, active: true, permission: false, gatewayFailed: false },
      { hasOperation: true, exists: true, active: false, permission: true, gatewayFailed: false },
      { hasOperation: true, exists: true, active: true, permission: false, gatewayFailed: true },
    ];
    for (const input of inputs) {
      const decision = recoverExecution(input);
      assert.equal(decision.redispath, false);
      if (input.gatewayFailed) assert.equal(decision.status, 'unchanged');
    }
    assert.equal(recoverExecution(inputs[2]).status, 'needs_check');
    assert.equal(reduceCollaboration({ runId: null, phase: null, control: null, confirmation: null, error: null, message: null }).kind, 'starting');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'executing', control: 'running', confirmation: null, error: null, message: '' }).kind, 'executing');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'planning', control: 'paused', confirmation: 'plan', error: null, message: '等待批准' }).kind, 'executing');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'reviewing', control: 'running', confirmation: null, error: null, message: '' }).kind, 'executing');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'final_review', control: 'running', confirmation: null, error: null, message: '' }).kind, 'executing');
    const pending = reduceCollaboration({ runId: 'run', phase: 'awaiting_acceptance', control: 'paused', confirmation: 'final', error: null, message: '等待验收' });
    assert.equal(pending.kind, 'solidify');
    if (pending.kind === 'solidify') assert.equal(pending.acceptance, 'pending');
    const accepted = reduceCollaboration({ runId: 'run', phase: 'completed', control: 'running', confirmation: null, error: null, message: '已验收' });
    assert.equal(accepted.kind, 'solidify');
    if (accepted.kind === 'solidify') assert.equal(accepted.acceptance, 'accepted');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'executing', control: 'needs_attention', confirmation: null, error: null, message: '执行受阻' }).kind, 'blocked');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'awaiting_acceptance', control: 'canceled', confirmation: null, error: null, message: '不采纳' }).kind, 'canceled');
    assert.equal(reduceCollaboration({ runId: 'run', phase: 'executing', control: 'waiting_permission', confirmation: null, error: null, message: '' }).kind, 'permission');
    assert.equal(reduceCollaboration({ runId: null, phase: null, control: null, confirmation: null, error: '会话失败', message: null }).kind, 'failed');
    assert.equal(reviewsMatch(review, { ...review }), true);
    assert.equal(reviewsMatch(review, { ...review, resultTree: 'd'.repeat(40) }), false);
    assert.equal(reviewsMatch(null, review), false);
  });
});
