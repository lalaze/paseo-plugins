import { z } from 'zod';
import type { Task } from './schema';

export const DOT_CONFIRMATION_URL = 'https://chatgpt.com/dots/home';
export const permissionScopeSchema = z.object({
  toolName: z.string().min(1).max(120),
  action: z.string().trim().min(1).max(1000),
  targets: z.array(z.string().trim().min(1).max(500)).min(1).max(64),
}).strict().refine(scope => scope.targets.join('\n').length <= 4000, 'Permission targets exceed display limit');

export const permissionIntentSchema = z.object({
  requestId: z.string().uuid(),
  userMessageSeq: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  scope: permissionScopeSchema,
}).strict();

export const permissionSchema = permissionIntentSchema.extend({
  roundId: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  requestedAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().nullable().default(null),
  decisionMessageSeq: z.number().int().positive().nullable().default(null),
  platformBlock: z.object({ reason: z.string().min(1).max(2000), at: z.number().int().nonnegative() }).strict().nullable().default(null),
}).strict();
export type DotPermission = z.infer<typeof permissionSchema>;
export type PermissionIntent = z.infer<typeof permissionIntentSchema>;

/** A saved decision is evidence of a scoped user choice, never a ChatGPT platform approval. */
export function permissionCurrent(task: Task, permission: DotPermission): boolean {
  const round = task.rounds.find(r => r.roundId === task.currentRoundId);
  return task.currentRoundId === permission.roundId && !!round?.claim && !round.stop.requested
    && ['claimed', 'running', 'waiting_user'].includes(task.status)
    && task.userMessageSeq === (permission.decisionMessageSeq ?? permission.userMessageSeq);
}

export function pendingPermissions(task: Task): DotPermission[] {
  return task.permissions.filter(p => p.status === 'pending' && permissionCurrent(task, p));
}

export function permissionDescription(p: PermissionIntent): string {
  return `${p.description}\n\n操作：${p.scope.action}\n工具：${p.scope.toolName}\n范围：\n${p.scope.targets.map(path => `• ${path}`).join('\n')}\n\n仅授权本次请求的范围；Paseo 确认不等于 ChatGPT 平台审批。`;
}

export function permissionPromptId(taskId: string, requestId: string): string {
  return `${taskId}:permission:${requestId}`;
}
