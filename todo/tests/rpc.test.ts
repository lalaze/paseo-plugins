import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collaborationSettingsSchema, taskCollaborationSchema } from '../shared/collaboration';
import { acceptTask, createTask, deleteTask, listTasks, readCollaborationCatalog, updateTaskCollaboration } from '../shared/rpc';
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

  it('validates delete task input', () => {
    assert.equal(deleteTask.input.safeParse({ id }).success, true);
    assert.equal(deleteTask.input.safeParse({ id: 'invalid-id' }).success, false);
    assert.equal(deleteTask.input.safeParse({ id, extra: true }).success, false);
    assert.equal(deleteTask.input.safeParse({}).success, false);
  });

  it('lists every task or only one repository', () => {
    assert.equal(listTasks.input.safeParse({}).success, true);
    assert.equal(listTasks.input.safeParse({ repository: '/repo' }).success, true);
    assert.equal(listTasks.input.safeParse({ repository: '' }).success, false);
  });
});

const settings = collaborationSettingsSchema.parse({
  profiles: [
    { id: 'director', label: 'Design', provider: 'stub/design', transport: 'mcp' },
    { id: 'worker', label: 'Work', provider: 'stub/work', transport: 'mcp' },
    { id: 'reviewer', label: 'Review', provider: 'stub/review', transport: 'mcp' },
  ],
  directorProfileId: 'director',
  workerProfileId: 'worker',
  reviewerProfileId: 'reviewer',
});

describe('collaboration rpc', () => {
  it('accepts a task snapshot on create and requires one on update', () => {
    const base = {
      title: 'Task', prompt: 'Do the work', repository: '/repo', projectId: null, projectName: null,
      targetBranch: 'main', provider: 'stub/model', modeId: null,
    };
    assert.equal(createTask.input.safeParse(base).success, true);
    assert.equal(createTask.input.safeParse({ ...base, collaboration: null }).success, true);
    assert.equal(createTask.input.safeParse({ ...base, collaboration: { mode: 'full', settings } }).success, true);
    assert.equal(createTask.input.safeParse({ ...base, collaboration: { mode: 'execute_review', settings: { ...settings, reviewerProfileId: undefined } } }).success, false);
    assert.equal(createTask.input.safeParse({ ...base, extra: true }).success, false);
    assert.equal(updateTaskCollaboration.input.safeParse({ id }).success, false);
    assert.equal(updateTaskCollaboration.input.safeParse({ id, collaboration: null }).success, true);
    assert.equal(updateTaskCollaboration.input.safeParse({ id, collaboration: { mode: 'full', settings }, extra: true }).success, false);
    assert.equal(readCollaborationCatalog.input.safeParse({}).success, true);
    assert.equal(readCollaborationCatalog.input.safeParse({ host: 'other' }).success, false);
    assert.equal(taskCollaborationSchema.safeParse({ mode: 'sideways', settings }).success, false);
  });
});
