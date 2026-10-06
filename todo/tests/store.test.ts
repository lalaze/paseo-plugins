import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TaskStore } from '../server/store';
import { taskSchema, type Task } from '../shared/schema';

function draft(id: string): Task {
  return taskSchema.parse({
    id, title: 'Task', prompt: 'Do the work', pendingPrompt: null, repository: '/tmp/repo',
    projectId: null, projectName: null, targetBranch: 'main', provider: 'stub/model', modeId: null,
    status: 'draft', branch: null, worktree: null, baseCommit: null, agentId: null, workspaceId: null,
    operationId: null, operationIds: [], review: null, lastOutcome: null, pendingMergeCommit: null,
    mergeCommit: null, mergeMethod: null, errorCode: null, errorDetail: null, createdAt: 1, updatedAt: 1,
  });
}

describe('task store', () => {
  it('lets the owner release the lock and refuses a second live opener', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
    try {
      const first = await TaskStore.open(dir);
      assert.equal(first.loadError, null);
      const second = await TaskStore.open(dir);
      assert.equal(second.loadError, 'store-locked');
      await second.dispose();
      assert.equal((await TaskStore.open(dir)).loadError, 'store-locked');
      await first.dispose();
      const third = await TaskStore.open(dir);
      assert.equal(third.loadError, null);
      await third.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not delete an empty, invalid, or dead lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
    try {
      const empty = join(dir, 'state.lock');
      await writeFile(empty, '');
      const opened = await TaskStore.open(dir);
      assert.equal(opened.loadError, 'store-locked');
      assert.equal(await readFile(empty, 'utf8'), '');
      await opened.dispose();
      await rm(empty);

      await mkdir(empty);
      await writeFile(join(empty, 'owner'), 'not-a-pid');
      const invalid = await TaskStore.open(dir);
      assert.equal(invalid.loadError, 'store-locked');
      assert.equal(await readFile(join(empty, 'owner'), 'utf8'), 'not-a-pid');
      await invalid.dispose();
      await rm(empty, { recursive: true });

      await mkdir(empty);
      await writeFile(join(empty, 'owner'), '999999:11111111-1111-4111-8111-111111111111');
      const dead = await TaskStore.open(dir);
      assert.equal(dead.loadError, 'store-locked');
      assert.equal(await readFile(join(empty, 'owner'), 'utf8'), '999999:11111111-1111-4111-8111-111111111111');
      await dead.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous tasks when a write fails and does not overwrite a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
    try {
      let fail = false;
      const store = await TaskStore.open(dir, {
        write: async body => {
          if (fail) throw new Error('disk');
          await writeFile(join(dir, 'state.json'), body, { mode: 0o600 });
        },
      });
      await store.insert(draft('11111111-1111-4111-8111-111111111111'));
      fail = true;
      await assert.rejects(() => store.insert(draft('22222222-2222-4222-8222-222222222222')), /disk/);
      assert.equal(store.list().length, 1);
      assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).tasks.length, 1);
      await store.dispose();

      const corrupt = '{"version":1,"tasks":[{"nope":true}]}';
      await writeFile(join(dir, 'state.json'), corrupt);
      const broken = await TaskStore.open(dir);
      assert.ok(broken.loadError);
      await assert.rejects(() => broken.insert(draft('33333333-3333-4333-8333-333333333333')));
      assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), corrupt);
      await broken.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finds a task by agent and hands out an isolated copy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
    try {
      const store = await TaskStore.open(dir);
      const task = { ...draft('11111111-1111-4111-8111-111111111111'), agentId: 'agent-1' };
      await store.insert(task);
      const found = store.findByAgent('agent-1');
      assert.equal(found?.id, task.id);
      assert.equal(store.findByAgent('agent-nope'), null);
      assert.ok(found);
      found.title = 'mutated';
      assert.equal(store.findByAgent('agent-1')?.title, 'Task');
      await store.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads an archive saved before collaboration fields existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
    try {
      const legacy = {
        version: 1,
        tasks: [{
          id: '11111111-1111-4111-8111-111111111111', title: 'Old', prompt: 'Work', pendingPrompt: null,
          repository: '/tmp/repo', projectId: null, projectName: null, targetBranch: 'main', provider: 'stub/model',
          modeId: null, status: 'draft', branch: null, worktree: null, baseCommit: null, agentId: null, workspaceId: null,
          operationId: null, operationIds: [], review: null, lastOutcome: null, pendingMergeCommit: null,
          mergeCommit: null, mergeMethod: null, errorCode: null, errorDetail: null, createdAt: 1, updatedAt: 1,
        }],
      };
      await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
      const store = await TaskStore.open(dir);
      const task = store.get(legacy.tasks[0].id);
      assert.equal(store.loadError, null);
      assert.equal(task.collaboration, null);
      assert.equal(task.collaborationConversationId, null);
      assert.equal(task.collaborationRunId, null);
      assert.equal(task.cleanup, null);
      await store.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
