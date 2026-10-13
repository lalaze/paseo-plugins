import { z } from 'zod';
import type { Task } from './schema';
import { fileHashSchema, localPathSchema } from './local-files';
import { attachmentContentSchema, attachmentNameSchema, MAX_FILE_BYTES } from './attachments';

/** A mutation approval binds the operation id and bytes, not just its display description. */
export const permissionOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('files'), operationId: z.string().uuid(),
    changes: z.array(z.object({ path: localPathSchema, expectedSha256: fileHashSchema.nullable(), contentSha256: fileHashSchema.nullable() }).strict()).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal('attachment'), operationId: z.string().uuid(),
    name: attachmentNameSchema, mediaType: attachmentContentSchema.shape.mediaType,
    size: z.number().int().nonnegative().max(MAX_FILE_BYTES), sha256: fileHashSchema,
  }).strict(),
]);
export type PermissionOperation = z.infer<typeof permissionOperationSchema>;
export const mutationPermissionTools: ReadonlySet<string> = new Set(['apply_dot_changes', 'upload_dot_attachment', 'upload_dot_attachment_chunk']);
export const attachmentReadPermissionTools: ReadonlySet<string> = new Set(['read_dot_attachment', 'read_dot_attachment_chunk']);
/** Only these two concrete tools are aliases. External tool names never act as group names. */
export function samePermissionTool(left: string, right: string): boolean {
  return left === right || (attachmentReadPermissionTools.has(left) && attachmentReadPermissionTools.has(right));
}
export function samePermissionFamily(left: string, right: string): boolean {
  return samePermissionTool(left, right) || (mutationPermissionTools.has(left) && mutationPermissionTools.has(right));
}

export const DOT_CONFIRMATION_URL = 'https://chatgpt.com/dots/home';
export const permissionScopeSchema = z.object({
  toolName: z.string().min(1).max(120),
  action: z.string().trim().min(1).max(1000),
  targets: z.array(z.string().trim().min(1).max(500)).min(1).max(64),
  operation: permissionOperationSchema.nullable().default(null),
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
  consumedAt: z.number().int().nonnegative().nullable().default(null),
}).strict();
export type DotPermission = z.infer<typeof permissionSchema>;
export type PermissionIntent = z.input<typeof permissionIntentSchema>;

/** A saved decision is evidence of a scoped user choice, never a ChatGPT platform approval. */
export function permissionCurrent(task: Task, permission: DotPermission): boolean {
  const round = task.rounds.find(r => r.roundId === task.currentRoundId);
  return task.currentRoundId === permission.roundId && !!round?.claim && !round.stop.requested
    && ['claimed', 'running', 'waiting_user'].includes(task.status)
    && permission.consumedAt === null
    && task.userMessageSeq === (permission.decisionMessageSeq ?? permission.userMessageSeq);
}

export function pendingPermissions(task: Task): DotPermission[] {
  return task.permissions.filter(p => p.status === 'pending' && permissionCurrent(task, p));
}

export function permissionDescription(p: PermissionIntent): string {
  const operation = p.scope.operation;
  const details = operation?.kind === 'files'
    ? operation.changes.map(c => `${c.contentSha256 === null ? '删除' : c.expectedSha256 === null ? '新建' : '修改'} ${c.path}`).join('\n')
    : operation?.kind === 'attachment' ? `上传 ${operation.name}（${operation.size} bytes，${operation.mediaType}）` : '';
  const lifetime = operation ? '仅允许绑定内容的一次操作；内容或操作编号变化必须重新确认。'
    : /^(read_dot_|list_dot_files)/.test(p.scope.toolName) ? '仅允许当前消息下重复读取上述精确目标；新消息后需重新确认。不授权文件写入或附件上传。' : '外部工具由 Dot 和平台执行，Bridge 无法强制限制该工具。本次确认不授权 Bridge 文件写入或附件上传。';
  return `${p.description}\n\n操作：${p.scope.action}\n工具：${p.scope.toolName}\n范围：\n${p.scope.targets.map(path => `• ${path}`).join('\n')}${details ? `\n\n实际操作：\n${details}` : ''}\n\n${lifetime}\nPaseo 确认不等于 ChatGPT 平台审批。`;
}

export function permissionState(task: Task, p: DotPermission): 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'platform-blocked' | 'superseded' {
  if (p.consumedAt !== null) return 'consumed';
  const index = task.permissions.findIndex(item => item.requestId === p.requestId);
  if (index >= 0 && task.permissions.slice(index + 1).some(item => samePermissionFamily(item.scope.toolName, p.scope.toolName))) return 'superseded';
  if (p.status === 'denied') return 'denied';
  if (!permissionCurrent(task, p) || p.status === 'expired') return 'expired';
  if (p.platformBlock) return 'platform-blocked';
  return p.status;
}

export function permissionPromptId(taskId: string, requestId: string): string {
  return `${taskId}:permission:${requestId}`;
}
