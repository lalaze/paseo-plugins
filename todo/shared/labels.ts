/** Status names on cards. English and Chinese stay paired so a missing translation is a type error. */
import { ui } from './i18n';
import { TASK_STATUSES, type TaskStatus } from './machine';

const labels: Record<TaskStatus, readonly [string, string]> = {
  draft: ['Draft', '草稿'],
  queued: ['Queued', '排队中'],
  preparing: ['Preparing', '准备中'],
  running: ['Running', '执行中'],
  needs_attention: ['Needs permission', '待权限'],
  awaiting_review: ['Awaiting review', '待验收'],
  needs_check: ['Needs check', '待核对'],
  failed: ['Failed', '失败'],
  canceling: ['Canceling', '取消中'],
  canceled: ['Canceled', '已取消'],
  merging: ['Merging', '合并中'],
  merged: ['Merged', '已合并'],
  merge_failed: ['Merge failed', '合并失败'],
};

export function statusLabel(status: TaskStatus): string {
  const pair = labels[status];
  return ui(pair[0], pair[1]);
}

export function allStatusLabels(): Record<TaskStatus, readonly [string, string]> {
  return Object.fromEntries(TASK_STATUSES.map(status => [status, labels[status]])) as Record<TaskStatus, readonly [string, string]>;
}
