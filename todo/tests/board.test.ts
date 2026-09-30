import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allStatusesFiled, columnFor, diffLineKind, diffStats, groupTasks, relativeAge } from '../shared/board';
import type { Task } from '../shared/schema';

function task(id: string, status: Task['status'], updatedAt: number): Task {
  return {
    id, title: id, prompt: id, pendingPrompt: null, repository: '/r', projectId: null, projectName: null,
    targetBranch: 'main', provider: 'a/b', modeId: null, status, branch: null, worktree: null, baseCommit: null,
    agentId: null, workspaceId: null, operationId: null, operationIds: [], review: null, lastOutcome: null,
    pendingMergeCommit: null, mergeCommit: null, mergeMethod: null, errorCode: null, errorDetail: null,
    createdAt: 0, updatedAt,
  };
}

describe('board', () => {
  it('files every status in exactly one column', () => {
    assert.equal(allStatusesFiled(), true);
    assert.equal(columnFor('draft'), 'todo');
    assert.equal(columnFor('running'), 'inProgress');
    assert.equal(columnFor('awaiting_review'), 'attention');
    assert.equal(columnFor('merging'), 'attention');
    assert.equal(columnFor('merged'), 'done');
  });

  it('orders each column freshest first and hides canceled unless asked', () => {
    const tasks = [task('old', 'draft', 1), task('new', 'queued', 5), task('gone', 'canceled', 9), task('ok', 'merged', 3)];
    const grouped = groupTasks(tasks, false);
    assert.deepEqual(grouped.todo.map(item => item.id), ['new', 'old']);
    assert.deepEqual(grouped.done.map(item => item.id), ['ok']);
    assert.deepEqual(groupTasks(tasks, true).done.map(item => item.id), ['gone', 'ok']);
  });

  it('formats ages and counts diff lines without the file headers', () => {
    assert.equal(relativeAge(0, 30_000), '30s');
    assert.equal(relativeAge(0, 5 * 60_000), '5m');
    assert.equal(relativeAge(0, 23 * 3_600_000), '23h');
    assert.equal(relativeAge(0, 2 * 86_400_000), '2d');
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n same';
    assert.deepEqual(diffStats(patch), { additions: 2, deletions: 1 });
    assert.equal(diffLineKind('@@ -1 +1 @@'), 'hunk');
    assert.equal(diffLineKind('+++ b/x'), 'meta');
  });
});
