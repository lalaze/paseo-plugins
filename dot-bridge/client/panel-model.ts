/**
 * Pure view model for the Dot tasks panel: status grouping, search filtering and time formatting.
 *
 * Everything here is derived from an already-loaded task list. It never mutates a task, never
 * changes a status and never decides that work is user-approved — it only picks what to display and
 * how to label it. Keeping it framework-free lets the behaviour be unit tested without a host.
 */
import type { RemoteStatus, Task } from '../shared/schema';

/** Coarse history buckets. `all` is the identity filter; the rest map from the true remote status. */
export type TaskStatusGroup = 'all' | 'active' | 'waiting' | 'completed' | 'failed';

/** Every bucket in display order. */
export const TASK_STATUS_GROUPS: readonly TaskStatusGroup[] = ['all', 'active', 'waiting', 'completed', 'failed'];

/** A semantic colour slot the panel maps to the host theme; kept here so it can be tested. */
export type StatusTone = 'muted' | 'accent' | 'warning' | 'success' | 'danger';

export interface WorkspaceChoice {
  id: string;
  label: string;
}

export interface TaskFilter {
  query: string;
  group: TaskStatusGroup;
}

export function statusTone(status: RemoteStatus, opts: { localCancel?: boolean } = {}): StatusTone {
  switch (status) {
    case 'queued':
      return 'muted';
    case 'dispatched':
    case 'claimed':
    case 'running':
      return 'accent';
    case 'waiting_user':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'stopped':
      return opts.localCancel ? 'muted' : 'danger';
  }
}

/**
 * Which history bucket a task belongs to. A local cancel is still a stopped round, so it stays in
 * the failed/stopped bucket even though its label reads "canceled locally".
 */
export function taskStatusGroup(task: Task): Exclude<TaskStatusGroup, 'all'> {
  switch (task.status) {
    case 'queued':
    case 'dispatched':
    case 'claimed':
    case 'running':
      return 'active';
    case 'waiting_user':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'stopped':
      return 'failed';
  }
}

const SEARCH_FIELDS = (task: Task): string[] => [
  task.title,
  task.requirement,
  task.workspaceId,
  task.repository ?? '',
  task.branch ?? '',
  task.remoteOrigin?.deviceId ?? '',
];

/** Case-insensitive substring match across the fields a user would reasonably search by. */
export function matchesTaskSearch(task: Task, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  return SEARCH_FIELDS(task).some(field => field.toLowerCase().includes(query));
}

/** Filtered view of the loaded task list. The source order is preserved so nothing jumps around. */
export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  return tasks.filter(task => (filter.group === 'all' || taskStatusGroup(task) === filter.group) && matchesTaskSearch(task, filter.query));
}

export function groupCounts(tasks: readonly Task[]): Record<TaskStatusGroup, number> {
  const counts: Record<TaskStatusGroup, number> = { all: tasks.length, active: 0, waiting: 0, completed: 0, failed: 0 };
  for (const task of tasks) counts[taskStatusGroup(task)] += 1;
  return counts;
}

export function hasActiveFilter(filter: TaskFilter): boolean {
  return filter.group !== 'all' || filter.query.trim().length > 0;
}

/** Filter the workspace picker by its visible label (the full id is always kept searchable too). */
export function filterWorkspaces(choices: readonly WorkspaceChoice[], rawQuery: string): WorkspaceChoice[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [...choices];
  return choices.filter(choice => choice.label.toLowerCase().includes(query) || choice.id.toLowerCase().includes(query));
}

export type UiLocaleTag = 'en' | 'zh-CN';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact, honest age from a real `updatedAt` epoch. Falls back to an ISO date once a task is older
 * than 30 days, so a stale timestamp is never rounded into something misleading.
 */
export function formatTimeAgo(updatedAt: number, now: number, locale: UiLocaleTag): string {
  const delta = Math.max(0, now - updatedAt);
  if (delta < MINUTE) return locale === 'zh-CN' ? '刚刚' : 'just now';
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return locale === 'zh-CN' ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return locale === 'zh-CN' ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days < 30) return locale === 'zh-CN' ? `${days} 天前` : `${days}d ago`;
  return new Date(updatedAt).toISOString().slice(0, 10);
}
