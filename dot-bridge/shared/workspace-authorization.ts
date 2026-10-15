import { z } from 'zod';
import { defineRpc } from '@getpaseo/plugin';

/** Host settings only. This record is never accepted from MCP or task contents. */
export const workspaceGrantSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1).max(200),
  workspaceRoot: z.string().min(1).max(4000), rootIdentity: z.string().min(1).max(200),
  enabledAt: z.number().int().nonnegative(),
}).strict();
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>;
export const automaticPermissionTools: ReadonlySet<string> = new Set([
  'list_dot_files', 'read_dot_file', 'read_dot_workspace_changes', 'apply_dot_changes',
  'read_dot_attachment', 'read_dot_attachment_chunk', 'upload_dot_attachment', 'upload_dot_attachment_chunk',
  'run_dot_command', 'read_dot_process', 'list_dot_processes', 'stop_dot_process',
]);
export const workspaceAuthorizationStatusSchema = z.object({
  workspaceId: z.string(), workspaceRoot: z.string(), rootIdentity: z.string(), enabled: z.boolean(), revision: z.string(),
}).strict();
export const workspaceAuthorizationGet = defineRpc({ name: 'workspace-authorization-get',
  input: z.object({ workspaceId: z.string().min(1).max(200) }).strict(), output: workspaceAuthorizationStatusSchema });
export const workspaceAuthorizationSet = defineRpc({ name: 'workspace-authorization-set',
  input: z.object({ workspaceId: z.string().min(1).max(200), workspaceRoot: z.string().min(1).max(4000), rootIdentity: z.string().min(1).max(200), enabled: z.boolean(), revision: z.string(), confirm: z.literal(true) }).strict(), output: workspaceAuthorizationStatusSchema });
export const AUTOMATIC_AUTHORIZATION_INSTRUCTIONS = 'The host user may opt in to automatic authorization for one exact local workspace. Inspect workspaceAutomaticAuthorization on get_dot_task. When enabled, task-related Bridge file reads/edits, attachment delivery and host commands may proceed without asking for another operation card, subject to explicit user restrictions, existing pending confirmations, denials, platform blocks, active round/claim/stop/message checks and file hashes. Commands still run with the host user privileges, not a filesystem/network sandbox. Disabled, changed-root, other-workspace and remote tasks never receive this grant. An automatically approved permission record has workspaceGrantId and is policy evidence, not a user clicking Allow or ChatGPT platform approval. If the grant is disabled or replaced, its unused approvals become invalid; do not repeatedly retry refused calls or broaden the scope. A platform block limited to process-status reads does not disable independently authorized current-task mutations; the blocked lookup remains forbidden, including equivalent access through another tool. The setting cannot be changed through MCP. Automatic authorization never changes the actual ChatGPT platform decision.';
