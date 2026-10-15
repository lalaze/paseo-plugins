import { z } from 'zod';
import type { Task } from './schema';
import { fileHashSchema, localPathSchema } from './local-files';
import { attachmentContentSchema, attachmentNameSchema, MAX_FILE_BYTES } from './attachments';
import { commandSpecSchema, commandRootAliases } from './processes';

/** A mutation approval binds the operation id and bytes, not just its display description. */
export const permissionOperationSchema = z.discriminatedUnion('kind', [
  commandSpecSchema.safeExtend({ kind: z.literal('command'), operationId: z.string().uuid() }),
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
export const mutationPermissionTools: ReadonlySet<string> = new Set(['apply_dot_changes', 'upload_dot_attachment', 'upload_dot_attachment_chunk', 'run_dot_command']);
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
}).strict().refine(scope => scope.targets.join('\n').length <= 4000, 'Permission targets exceed display limit')
  .transform(scope => scope.toolName === 'run_dot_command' && scope.operation?.kind === 'command' && scope.operation.cwd === ''
    ? { ...scope, targets: scope.targets.map(target => commandRootAliases.has(target) ? '/' : target) }
    : scope);

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
  /** Automatic authorization is sourced from a host workspace grant, never a fabricated click. */
  workspaceGrantId: z.string().uuid().optional(),
}).strict();
export type DotPermission = z.infer<typeof permissionSchema>;
export type PermissionIntent = z.input<typeof permissionIntentSchema>;
export const permissionBlockIntentSchema = permissionIntentSchema.omit({ requestId: true });
export type PermissionBlockIntent = z.input<typeof permissionBlockIntentSchema>;

/** A saved decision is evidence of a scoped user choice, never a ChatGPT platform approval. */
export function permissionCurrent(task: Task, permission: DotPermission): boolean {
  const round = task.rounds.find(r => r.roundId === task.currentRoundId);
  return task.currentRoundId === permission.roundId && !!round?.claim && !round.stop.requested
    && ['claimed', 'running', 'waiting_user'].includes(task.status)
    && permission.consumedAt === null
    && task.userMessageSeq === (permission.decisionMessageSeq ?? permission.userMessageSeq);
}

export function pendingPermissions(task: Task): DotPermission[] {
  return task.permissions.filter(p => p.status === 'pending' && !p.platformBlock && permissionCurrent(task, p));
}

export function permissionDescription(p: PermissionIntent): string {
  const operation = p.scope.operation;
  const details = operation?.kind === 'files'
    ? operation.changes.map(c => `${c.contentSha256 === null ? '删除' : c.expectedSha256 === null ? '新建' : '修改'} ${c.path}`).join('\n')
    : operation?.kind === 'attachment' ? `上传 ${operation.name}（${operation.size} bytes，${operation.mediaType}）`
    : operation?.kind === 'command' ? `执行文件：${JSON.stringify(operation.command)}\n参数：${JSON.stringify(operation.args)}\n工作目录：${operation.cwd || '/'}\n最长运行：${operation.timeoutMs} ms\n以 Paseo 主机用户身份运行；不是文件系统或网络沙箱，可访问工作区外的文件和网络。不会继承 daemon 的任意环境变量。` : '';
  const lifetime = operation ? '仅允许绑定内容的一次操作；内容或操作编号变化必须重新确认。'
    : /^(read_dot_|list_dot_files|list_dot_processes)/.test(p.scope.toolName) ? '仅允许当前消息下重复读取上述精确目标；新消息后需重新确认。不授权文件写入或附件上传。' : '外部工具由 Dot 和平台执行，Bridge 无法强制限制该工具。本次确认不授权 Bridge 文件写入或附件上传。';
  return `${p.description}\n\n操作：${p.scope.action}\n工具：${p.scope.toolName}\n范围：\n${p.scope.targets.map(path => `• ${path}`).join('\n')}${details ? `\n\n实际操作：\n${details}` : ''}\n\n${lifetime}\nPaseo 确认不等于 ChatGPT 平台审批。`;
}

/** Display only. The original operation and its exact bytes remain the approval binding. */
export function permissionDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${ms / 1000} 秒`;
}

export function permissionCommand(p: PermissionIntent): string | null {
  const operation = p.scope.operation;
  if (operation?.kind !== 'command') return null;
  // POSIX quoting makes argument boundaries explicit, including literal shell metacharacters.
  const quote = (value: string) => /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return [operation.command, ...(operation.args ?? [])].map(quote).join(' ');
}

export function permissionSummary(p: PermissionIntent, workspaceRoot?: string | null): string {
  const operation = p.scope.operation;
  if (operation?.kind === 'command') {
    const directory = operation.cwd ? `${workspaceRoot ? `${workspaceRoot}/` : ''}${operation.cwd}` : workspaceRoot || '工作区根目录';
    return `目录：${directory}\n最长运行：${permissionDuration(operation.timeoutMs ?? 120_000)} · 仅本次\n主机权限运行，可访问工作区外文件和网络。\nPaseo 确认不等于 ChatGPT 平台审批。`;
  }
  if (operation?.kind === 'files') return `${operation.changes.map(c => `${c.contentSha256 === null ? '删除' : c.expectedSha256 === null ? '新建' : '修改'} ${c.path}`).join('\n')}\n仅本次操作 · Paseo 确认不等于 ChatGPT 平台审批。`;
  if (operation?.kind === 'attachment') return `上传：${operation.name} · ${operation.size} bytes\n仅本次操作 · Paseo 确认不等于 ChatGPT 平台审批。`;
  const read = /^(read_dot_|list_dot_files)/.test(p.scope.toolName);
  return `${p.scope.action}\n范围：${p.scope.targets.join('、')}\n${read ? '当前消息下的范围读取' : '仅确认上述请求'} · Paseo 确认不等于 ChatGPT 平台审批。`;
}

/** Native cards support a bounded plain-text detail view instead of the raw internal JSON. */
export function permissionDisplayDetails(p: PermissionIntent): string {
  const command = permissionCommand(p);
  return `${command ? `命令：${command}\n\n` : ''}${p.description}\n\n${p.scope.operation ? '仅批准绑定操作；参数或内容变化需重新确认。' : '新增范围或新消息不能沿用已失效的授权。'}`;
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
