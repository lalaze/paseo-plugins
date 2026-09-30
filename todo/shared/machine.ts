export const TASK_STATUSES = [
  'draft',
  'queued',
  'preparing',
  'running',
  'needs_attention',
  'awaiting_review',
  'needs_check',
  'failed',
  'canceling',
  'canceled',
  'merging',
  'merged',
  'merge_failed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TurnKind = 'completed' | 'failed' | 'canceled';

const EXECUTION: ReadonlySet<TaskStatus> = new Set(['preparing', 'running', 'needs_attention', 'canceling']);

export function isExecution(status: TaskStatus): boolean {
  return EXECUTION.has(status);
}

export function canEnqueue(status: TaskStatus): boolean {
  return status === 'draft';
}

export function canCancel(status: TaskStatus): boolean {
  return status === 'draft' || status === 'queued' || status === 'preparing' || status === 'running'
    || status === 'needs_attention' || status === 'awaiting_review' || status === 'needs_check'
    || status === 'failed' || status === 'merge_failed';
}

export function canAccept(status: TaskStatus): boolean {
  return status === 'awaiting_review' || status === 'merge_failed';
}

export function canRetry(status: TaskStatus): boolean {
  return status === 'failed' || status === 'canceled' || status === 'needs_check' || status === 'merge_failed';
}

export function canContinue(status: TaskStatus): boolean {
  return status === 'awaiting_review' || status === 'needs_check' || status === 'failed' || status === 'merge_failed';
}

/** Turn outcomes are the only completion signal. Idle is not a `TurnKind`. */
export function reduceTurn(status: TaskStatus, kind: TurnKind): TaskStatus | null {
  if (status === 'canceling') return 'canceled';
  if (status !== 'preparing' && status !== 'running' && status !== 'needs_attention') return null;
  if (kind === 'completed') return 'awaiting_review';
  if (kind === 'failed') return 'failed';
  return 'canceled';
}

export function reducePermission(status: TaskStatus, pending: boolean): TaskStatus {
  if (pending && status === 'running') return 'needs_attention';
  if (!pending && status === 'needs_attention') return 'running';
  return status;
}

export interface RecoverInput {
  hasOperation: boolean;
  exists: boolean;
  active: boolean;
  permission: boolean;
  gatewayFailed: boolean;
}

/** Recovery never asks the caller to send the prompt again. */
export function recoverExecution(input: RecoverInput): { status: TaskStatus | 'unchanged'; redispath: false } {
  if (input.gatewayFailed) return { status: 'unchanged', redispath: false };
  if (!input.hasOperation || !input.exists) return { status: 'needs_check', redispath: false };
  if (input.permission) return { status: 'needs_attention', redispath: false };
  if (input.active) return { status: 'running', redispath: false };
  return { status: 'needs_check', redispath: false };
}
