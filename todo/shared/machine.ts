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

/** Preparing, running, waiting for permission, or canceling. These hold the repository's execution slot. */
export function isExecution(status: TaskStatus): boolean {
  return EXECUTION.has(status);
}

/** What the buttons may offer. The engine checks the same functions, so the page cannot offer an action the server rejects. */
export function canEnqueue(status: TaskStatus): boolean {
  return status === 'draft';
}

export function canCancel(status: TaskStatus): boolean {
  return status === 'draft' || status === 'queued' || status === 'preparing' || status === 'running'
    || status === 'needs_attention' || status === 'awaiting_review' || status === 'needs_check'
    || status === 'failed' || status === 'merge_failed' || status === 'canceling';
}

export function canDelete(status: TaskStatus): boolean {
  return !isExecution(status) && status !== 'merging';
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

/**
 * Turn outcomes are the only completion signal for a normal single-agent task.
 * A collaboration run does not use this: the main agent's turn is one step inside the host run.
 * Idle is not a `TurnKind`.
 */
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

export interface CollaborationObservation {
  runId: string | null;
  phase: string | null;
  control: string | null;
  /** Host confirmation card. Plan approval and final acceptance both wait for a real user in the session. */
  confirmation: 'plan' | 'final' | null;
  error: string | null;
  message: string | null;
}

export type CollaborationDecision =
  | { kind: 'starting' }
  | { kind: 'executing'; phase: string; control: string; runId: string | null }
  | { kind: 'permission'; phase: string; control: string; runId: string }
  | { kind: 'blocked'; phase: string; control: string; runId: string; message: string }
  | { kind: 'canceled'; phase: string | null; control: string; runId: string | null; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'solidify'; phase: 'awaiting_acceptance' | 'completed'; control: string; runId: string; acceptance: 'pending' | 'accepted'; message: string };

/**
 * Maps one host collaboration snapshot to the next todo effect.
 * Design, execution, review, and plan approval stay in progress.
 * Only a finished final review may be bound, and it stays pending until the user accepts in the session.
 */
export function reduceCollaboration(view: CollaborationObservation): CollaborationDecision {
  if (!view.runId) {
    if (view.error) return { kind: 'failed', message: view.error };
    return { kind: 'starting' };
  }
  const phase = view.phase ?? '';
  const control = view.control ?? '';
  const message = view.message ?? '';
  if (control === 'canceled') return { kind: 'canceled', phase: phase || null, control, runId: view.runId, message };
  if (control === 'needs_attention') return { kind: 'blocked', phase, control, runId: view.runId, message };
  if (phase === 'completed') return { kind: 'solidify', phase, control, runId: view.runId, acceptance: 'accepted', message };
  if (phase === 'awaiting_acceptance' || view.confirmation === 'final') {
    return { kind: 'solidify', phase: 'awaiting_acceptance', control: control || 'paused', runId: view.runId, acceptance: 'pending', message };
  }
  if (control === 'waiting_permission') return { kind: 'permission', phase: phase || 'executing', control, runId: view.runId };
  return { kind: 'executing', phase: phase || 'running', control: control || 'running', runId: view.runId };
}

/** Recovery never asks the caller to send the prompt again. */
export function recoverExecution(input: RecoverInput): { status: TaskStatus | 'unchanged'; redispath: false } {
  if (input.gatewayFailed) return { status: 'unchanged', redispath: false };
  if (!input.hasOperation || !input.exists) return { status: 'needs_check', redispath: false };
  if (input.permission) return { status: 'needs_attention', redispath: false };
  if (input.active) return { status: 'running', redispath: false };
  return { status: 'needs_check', redispath: false };
}
