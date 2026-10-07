/** Task, review binding, and catalog shapes. strict() rejects a renamed field instead of ignoring it. */
import { z } from 'zod';
import { taskCollaborationSchema } from './collaboration';
import { TASK_STATUSES } from './machine';

export const shaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
export const branchSchema = z.string().regex(/^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/);

export const reviewBindingSchema = z.object({
  resultCommit: shaSchema,
  resultTree: shaSchema,
  targetBranch: branchSchema,
  targetHead: shaSchema,
  turnId: z.string().min(1).max(200),
  operationId: z.string().uuid(),
}).strict();

export const outcomeSchema = z.object({
  kind: z.enum(['completed', 'failed', 'canceled']),
  turnId: z.string().min(1).max(200).nullable(),
  operationId: z.string().uuid(),
  at: z.number().int().nonnegative(),
}).strict();

/** Steps run after a merge: archive the task's sessions, remove its worktree, delete its branch. Each runs only after the one before it. */
export const cleanupSchema = z.object({
  sessions: z.boolean(),
  worktree: z.boolean(),
  branch: z.boolean(),
  error: z.string().max(4000).nullable(),
  at: z.number().int().nonnegative(),
}).strict();

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  pendingPrompt: z.string().min(1).max(20_000).nullable(),
  repository: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  projectName: z.string().min(1).max(200).nullable(),
  targetBranch: branchSchema,
  provider: z.string().regex(/^[^/\s]+\/[^/\s].{0,240}$/),
  modeId: z.string().min(1).max(200).nullable(),
  collaboration: taskCollaborationSchema.nullable().default(null),
  collaborationConversationId: z.string().min(1).max(200).nullable().default(null),
  collaborationRunId: z.string().min(1).max(200).nullable().default(null),
  /** Last host run phase. Null until the conversation has a run. */
  collaborationPhase: z.string().min(1).max(80).nullable().default(null),
  /** Last host run control (`running`, `paused`, `needs_attention`, …). */
  collaborationControl: z.string().min(1).max(80).nullable().default(null),
  /** `pending` while the host still waits for the user to accept in the session. `accepted` after that acceptance. */
  collaborationAcceptance: z.enum(['pending', 'accepted']).nullable().default(null),
  status: z.enum(TASK_STATUSES),
  branch: branchSchema.nullable(),
  worktree: z.string().min(1).nullable(),
  baseCommit: shaSchema.nullable(),
  agentId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1).nullable(),
  operationId: z.string().uuid().nullable(),
  operationIds: z.array(z.string().uuid()).max(100),
  review: reviewBindingSchema.nullable(),
  lastOutcome: outcomeSchema.nullable(),
  pendingMergeCommit: shaSchema.nullable(),
  mergeCommit: shaSchema.nullable(),
  mergeMethod: z.enum(['update-ref', 'ff-only']).nullable(),
  errorCode: z.string().min(1).max(80).nullable(),
  errorDetail: z.string().max(4000).nullable(),
  // Absent in tasks saved before cleanup existed.
  cleanup: cleanupSchema.nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const storeFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskSchema),
}).strict();

export type ReviewBinding = z.infer<typeof reviewBindingSchema>;

export function reviewsMatch(left: ReviewBinding | null, right: ReviewBinding | null): boolean {
  if (!left || !right) return false;
  return left.resultCommit === right.resultCommit
    && left.resultTree === right.resultTree
    && left.targetBranch === right.targetBranch
    && left.targetHead === right.targetHead
    && left.turnId === right.turnId
    && left.operationId === right.operationId;
}
export type TaskOutcome = z.infer<typeof outcomeSchema>;
export type TaskCleanup = z.infer<typeof cleanupSchema>;
export type Task = z.infer<typeof taskSchema>;
export type StoreFile = z.infer<typeof storeFileSchema>;

export const catalogSchema = z.object({
  projects: z.array(z.object({
    projectId: z.string(),
    name: z.string(),
    path: z.string(),
    kind: z.enum(['git', 'non_git', 'directory']),
  }).strict()),
  providers: z.array(z.object({
    provider: z.string(),
    label: z.string(),
    defaultModeId: z.string().nullable(),
    models: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    modes: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  }).strict()),
}).strict();

export const diffSchema = z.object({
  patch: z.string(),
  files: z.array(z.string()),
  truncated: z.boolean(),
}).strict();

export type Catalog = z.infer<typeof catalogSchema>;
export type TaskDiff = z.infer<typeof diffSchema>;
