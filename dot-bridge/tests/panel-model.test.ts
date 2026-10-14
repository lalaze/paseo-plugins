import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteStatus, Task } from '../shared/schema';
import {
  TASK_STATUS_GROUPS,
  filterTasks,
  filterWorkspaces,
  formatTimeAgo,
  groupCounts,
  hasActiveFilter,
  matchesTaskSearch,
  statusTone,
  taskStatusGroup,
} from '../client/panel-model';

const NOW = Date.UTC(2026, 9, 14, 6, 0, 0);

/** The view model only reads a handful of fields, so tests build that slice and cast to Task. */
function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    requirement: 'do something',
    workspaceId: 'ws-1',
    status: 'queued',
    mode: 'text',
    repository: null,
    branch: null,
    remoteOrigin: null,
    updatedAt: NOW,
    ...overrides,
  } as unknown as Task;
}

test('every remote status maps to exactly one history bucket', () => {
  const cases: Array<[RemoteStatus, string]> = [
    ['queued', 'active'],
    ['dispatched', 'active'],
    ['claimed', 'active'],
    ['running', 'active'],
    ['waiting_user', 'waiting'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['stopped', 'failed'],
  ];
  for (const [status, bucket] of cases) assert.equal(taskStatusGroup(task({ id: status, status })), bucket, status);
  // The buckets are stable and every non-all bucket is reachable.
  assert.deepEqual([...TASK_STATUS_GROUPS], ['all', 'active', 'waiting', 'completed', 'failed']);
});

test('status tone is semantic and a local cancel is not shown as a dot-reported failure', () => {
  assert.equal(statusTone('queued'), 'muted');
  assert.equal(statusTone('running'), 'accent');
  assert.equal(statusTone('waiting_user'), 'warning');
  assert.equal(statusTone('completed'), 'success');
  assert.equal(statusTone('failed'), 'danger');
  assert.equal(statusTone('stopped'), 'danger');
  assert.equal(statusTone('stopped', { localCancel: true }), 'muted');
});

test('search matches title, requirement, workspace, repository and remote device, case-insensitively', () => {
  const value = task({
    id: 'a',
    title: 'Fix Login Bug',
    requirement: 'The redirect loops',
    workspaceId: 'ws-alpha',
    repository: 'github.com/acme/web',
    branch: 'feat/LOGIN',
    remoteOrigin: { deviceId: 'device-42', workspaceId: 'ws-alpha' },
  });
  assert.equal(matchesTaskSearch(value, ''), true);
  assert.equal(matchesTaskSearch(value, '   '), true);
  assert.equal(matchesTaskSearch(value, 'login bug'), true);
  assert.equal(matchesTaskSearch(value, 'REDIRECT'), true);
  assert.equal(matchesTaskSearch(value, 'ws-alpha'), true);
  assert.equal(matchesTaskSearch(value, 'acme'), true);
  assert.equal(matchesTaskSearch(value, 'device-42'), true);
  assert.equal(matchesTaskSearch(value, 'nope'), false);
});

test('group and search filters combine, preserving source order', () => {
  const tasks = [
    task({ id: '1', title: 'alpha running', status: 'running' }),
    task({ id: '2', title: 'alpha waiting', status: 'waiting_user' }),
    task({ id: '3', title: 'beta running', status: 'dispatched' }),
    task({ id: '4', title: 'gamma failed', status: 'failed' }),
  ];
  assert.deepEqual(filterTasks(tasks, { query: '', group: 'all' }).map(t => t.id), ['1', '2', '3', '4']);
  assert.deepEqual(filterTasks(tasks, { query: 'alpha', group: 'all' }).map(t => t.id), ['1', '2']);
  assert.deepEqual(filterTasks(tasks, { query: 'alpha', group: 'waiting' }).map(t => t.id), ['2']);
  assert.deepEqual(filterTasks(tasks, { query: 'alpha', group: 'failed' }), []);
  assert.deepEqual(filterTasks(tasks, { query: '', group: 'active' }).map(t => t.id), ['1', '3']);
});

test('counts add up to the whole list and an empty list counts zero', () => {
  const tasks = [
    task({ id: '1', status: 'queued' }),
    task({ id: '2', status: 'waiting_user' }),
    task({ id: '3', status: 'completed' }),
    task({ id: '4', status: 'failed' }),
    task({ id: '5', status: 'stopped' }),
  ];
  const counts = groupCounts(tasks);
  assert.deepEqual(counts, { all: 5, active: 1, waiting: 1, completed: 1, failed: 2 });
  assert.deepEqual(groupCounts([]), { all: 0, active: 0, waiting: 0, completed: 0, failed: 0 });
  assert.equal(counts.all, counts.active + counts.waiting + counts.completed + counts.failed);
});

test('active filter is true for a group or a non-blank query only', () => {
  assert.equal(hasActiveFilter({ query: '', group: 'all' }), false);
  assert.equal(hasActiveFilter({ query: '  ', group: 'all' }), false);
  assert.equal(hasActiveFilter({ query: '', group: 'completed' }), true);
  assert.equal(hasActiveFilter({ query: 'x', group: 'all' }), true);
});

test('workspace picker filters by label and id and returns a copy for a blank query', () => {
  const choices = [
    { id: 'ws-1', label: 'main' },
    { id: 'ws-2', label: 'paseo-plugin' },
    { id: 'ws-3', label: 'Dot Bridge fixtures' },
  ];
  const blank = filterWorkspaces(choices, '');
  assert.deepEqual(blank, choices);
  assert.notEqual(blank, choices, 'a blank query must not expose the caller list');
  assert.deepEqual(filterWorkspaces(choices, 'PASEO').map(c => c.id), ['ws-2']);
  assert.deepEqual(filterWorkspaces(choices, 'ws-3').map(c => c.id), ['ws-3']);
  assert.deepEqual(filterWorkspaces(choices, 'missing'), []);
});

test('age is honest at each boundary and falls back to an ISO date when old', () => {
  assert.equal(formatTimeAgo(NOW - 10_000, NOW, 'zh-CN'), '刚刚');
  assert.equal(formatTimeAgo(NOW - 10_000, NOW, 'en'), 'just now');
  assert.equal(formatTimeAgo(NOW - 5 * 60_000, NOW, 'zh-CN'), '5 分钟前');
  assert.equal(formatTimeAgo(NOW - 5 * 60_000, NOW, 'en'), '5m ago');
  assert.equal(formatTimeAgo(NOW - 3 * 3_600_000, NOW, 'en'), '3h ago');
  assert.equal(formatTimeAgo(NOW - 2 * 86_400_000, NOW, 'zh-CN'), '2 天前');
  assert.equal(formatTimeAgo(NOW - 40 * 86_400_000, NOW, 'en'), '2026-09-04');
  assert.equal(formatTimeAgo(NOW + 5_000, NOW, 'en'), 'just now', 'a clock skew never shows a negative age');
});
