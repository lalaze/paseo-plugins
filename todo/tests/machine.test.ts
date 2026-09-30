import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recoverExecution, reducePermission, reduceTurn, type TurnKind } from '../shared/machine';
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
    assert.equal(reviewsMatch(review, { ...review }), true);
    assert.equal(reviewsMatch(review, { ...review, resultTree: 'd'.repeat(40) }), false);
    assert.equal(reviewsMatch(null, review), false);
  });
});
