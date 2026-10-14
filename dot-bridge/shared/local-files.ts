import { z } from 'zod';

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_CHANGE_BYTES = 1024 * 1024;
export const localPathSchema = z.string().min(1).max(1000);
export const fileHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const localChangeSchema = z.object({
  path: localPathSchema,
  /** null means create only if the path does not exist. Always use the hash from read_dot_file. */
  expectedSha256: fileHashSchema.nullable(),
  /** Full UTF-8 replacement, or null to delete one regular file. */
  content: z.string().max(MAX_SOURCE_BYTES).nullable(),
}).strict();
export const localChangesSchema = z.array(localChangeSchema).min(1).max(32)
  .refine(changes => new Set(changes.map(change => change.path)).size === changes.length, 'Duplicate file path');
export const localReceiptSchema = z.object({
  operationId: z.string().uuid(), roundId: z.string().uuid(),
  status: z.enum(['applied', 'conflict', 'partial']),
  files: z.array(z.object({ path: z.string(), action: z.enum(['create', 'update', 'delete']), beforeSha256: fileHashSchema.nullable(), afterSha256: fileHashSchema.nullable() }).strict()),
  conflicts: z.array(z.string()),
  at: z.number().int().nonnegative(),
}).strict();
export type LocalChange = z.infer<typeof localChangeSchema>;
export type LocalReceipt = z.infer<typeof localReceiptSchema>;

export const LOCAL_FILE_INSTRUCTIONS = 'Code changes are applied directly to this task\'s local workspace. Do not create a Git branch, cloud coding checkout, commit, push or PR. For requests to review current edits, first call read_dot_workspace_changes and follow nextOffset until null, passing the returned snapshotId on every continuation. Follow each nextDiffs item with snapshotId, path, diffKind and its byte diffOffset and sha256 as diffSha256 at offset 0 to read the remaining diff. If the snapshot changes, restart at offset 0 without snapshotId. This returns staged, unstaged and untracked disk/index changes, including flagged index files; unsaved editor buffers and already-committed branch changes are outside this scope. Mark conflicted files as unresolved; do not report them as safely merged. task.localChanges contains only Dot write receipts: an empty array is not evidence of a clean working tree. When scopeLimited is true, state that only explicitly authorized file paths were inspected. Disclose excluded paths, omitted/truncated diffs, unverified files, cross-workspace rename baselines and non-Git workspaces; never report no edits when the baseline or diff is unavailable. Use list_dot_files and read_dot_file to inspect relevant source files (including uncommitted changes). Follow workspace AGENTS.md instructions. Before editing each path, read it and keep its sha256 (null means absent). Use apply_dot_changes with the current userMessageSeq and a fresh operationId (or the exact approved operationId when permission was requested); send full UTF-8 file contents and expectedSha256 for each path. A null content deletes one file. Only make changes requested by the user. A stale hash or newer user message blocks the write: re-read and reconcile, never overwrite blindly. Retry uncertain requests using the identical operationId and payload. If the old payload is unavailable, read task.localChanges for its receipt; without one, re-read affected files and rebuild from current content under a new operationId, leaving out changes already present. An operation-bound approval cannot authorize this rebuilt payload: request a new scoped approval when access is guarded. Inspect the returned applied files and conflicts; partial/conflict is not success. File tools do not run tests. For local host tasks, use run_dot_command with active workspace automatic authorization or explicit command-bound approval; remote tasks have no command execution. Do not claim checks were run without actual process output and exit status. Report the actual applied files and any remaining checks, then finish with submit_dot_text_result. For additional authorization or unrelated/destructive work, use request_dot_permission and wait for the native decision. Bind apply_dot_changes approval to operationId and each path, expectedSha256 and contentSha256 (SHA-256 of the exact replacement UTF-8 bytes, null for deletion). Never change that payload or reuse the grant for another operation. Read requests use exact file paths, or / for the workspace root directory. Ordinary follow-ups do not renew expired or denied access.';
