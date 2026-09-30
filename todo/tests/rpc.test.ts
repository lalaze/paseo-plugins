import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptTask, listTasks } from '../shared/rpc';
import type { ReviewBinding } from '../shared/schema';

const id = '11111111-1111-4111-8111-111111111111';
const review: ReviewBinding = {
  resultCommit: 'a'.repeat(40), resultTree: 'b'.repeat(40), targetBranch: 'main',
  targetHead: 'c'.repeat(40), turnId: 'turn-1', operationId: id,
};

describe('accept task rpc', () => {
  it('requires the displayed review binding', () => {
    assert.equal(acceptTask.input.safeParse({ id }).success, false);
    assert.equal(acceptTask.input.safeParse({ id, review, extra: true }).success, false);
    assert.equal(acceptTask.input.safeParse({ id, review }).success, true);
  });

  it('lists every task or only one repository', () => {
    assert.equal(listTasks.input.safeParse({}).success, true);
    assert.equal(listTasks.input.safeParse({ repository: '/repo' }).success, true);
    assert.equal(listTasks.input.safeParse({ repository: '' }).success, false);
  });
});
