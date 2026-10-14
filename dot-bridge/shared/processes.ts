import { z } from 'zod';

const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'), 'NUL bytes are not supported');
/** Slash here is a workspace-root marker, never the host filesystem root. */
export const commandRootAliases: ReadonlySet<string> = new Set(['', '.', './', '/']);
export const commandCwdSchema = text(1000).default('')
  .describe('Directory relative to the bound workspace. Empty string, ., ./ and / mean the workspace root (not OS root). Absolute paths and parent traversal are refused.')
  .transform(cwd => commandRootAliases.has(cwd) ? '' : cwd);
/** No implicit shell. A shell, if needed, is itself an explicitly approved executable. */
export const commandSpecSchema = z.object({
  command: text(1000).refine(value => value.length > 0 && value === value.trim(), 'Executable is required'),
  args: z.array(text(8000)).max(128).default([]),
  cwd: commandCwdSchema,
  timeoutMs: z.number().int().min(100).max(86_400_000).default(120_000),
}).strict().refine(spec => spec.args.join('').length <= 32_000, 'Arguments exceed 32 KiB');
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const PROCESS_INSTRUCTIONS = 'Local command execution is available only on the Paseo host for a local task. Read project startup/test instructions first. For the workspace root use cwd="" and permission targets=["/"]; ., ./ and / are accepted root aliases and normalized to empty cwd. Never put the absolute workspaceRoot path in cwd. Other cwd values must be normalized relative directories, for example app (not ./app or app/). Always request_dot_permission for run_dot_command before starting: targets=[cwd || "/"], scope.operation={kind:"command",operationId,command,args,cwd,timeoutMs}. This is host execution with the user account, NOT a filesystem/network sandbox; commands and project scripts can access files outside the workspace and the network. Explain the actual effects, including network listeners. File-edit authorization alone never authorizes a command. After approval read the latest userMessageSeq, then run_dot_command with the SAME operationId and exact spec. waitMs only bounds the initial wait, not the process lifetime. For a service choose an explicit lifetime up to 24 hours and poll read_dot_process for actual logs/status. Success starting a process does not prove the service is ready: check its real startup output or use a separately approved probe command before reporting readiness. Return preview URLs using the configured reachable host; do not invent a port. Use stop_dot_process for cleanup. A task stop/local closure stops all Bridge-owned processes for that task. Processes may continue after a final answer until explicitly stopped, timed out or plugin unload; list_dot_processes finds them across rounds. Exact operation retries return the recorded process without executing again, even after interruption; changed specs need a new ID and approval. After a daemon crash an interrupted process has unknown external state; never claim it stopped or automatically restart it. This does not override ChatGPT platform approval or event-subscription restrictions.';
