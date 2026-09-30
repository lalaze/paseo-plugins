import { TASK_STATUSES, type TaskStatus } from './machine';
import type { Task } from './schema';

/** Four board columns, modelled on codeg's To-dos board. The columns aggregate the engine's statuses. */
export type BoardColumn = 'todo' | 'inProgress' | 'attention' | 'done';

export const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'inProgress', 'attention', 'done'];

export const STATUSES_BY_COLUMN: Record<BoardColumn, readonly TaskStatus[]> = {
  todo: ['draft', 'queued'],
  inProgress: ['preparing', 'running', 'canceling'],
  // Merging stays here so a card does not jump across the board while its merge runs.
  attention: ['needs_attention', 'awaiting_review', 'needs_check', 'failed', 'merging', 'merge_failed'],
  done: ['merged', 'canceled'],
};

const COLUMN_OF = new Map<TaskStatus, BoardColumn>(
  BOARD_COLUMNS.flatMap(column => STATUSES_BY_COLUMN[column].map(status => [status, column] as const)),
);

export function columnFor(status: TaskStatus): BoardColumn {
  const column = COLUMN_OF.get(status);
  if (!column) throw new Error(`status without a column: ${status}`);
  return column;
}

/** Freshest first in every column; canceled tasks are hidden unless asked for. */
export function groupTasks(tasks: readonly Task[], showCanceled: boolean): Record<BoardColumn, Task[]> {
  const grouped: Record<BoardColumn, Task[]> = { todo: [], inProgress: [], attention: [], done: [] };
  for (const task of tasks) {
    if (task.status === 'canceled' && !showCanceled) continue;
    grouped[columnFor(task.status)].push(task);
  }
  for (const column of BOARD_COLUMNS) grouped[column].sort((a, b) => b.updatedAt - a.updatedAt);
  return grouped;
}

export function relativeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

export function diffStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    const kind = diffLineKind(line);
    if (kind === 'add') additions += 1;
    else if (kind === 'del') deletions += 1;
  }
  return { additions, deletions };
}

export function allStatusesFiled(): boolean {
  const filed = BOARD_COLUMNS.flatMap(column => STATUSES_BY_COLUMN[column]);
  return filed.length === TASK_STATUSES.length && TASK_STATUSES.every(status => filed.includes(status));
}
