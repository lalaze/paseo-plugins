import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_SOURCE_BYTES } from '../shared/local-files';
import { canonicalWorkspace, readSource, validateLocalPath } from './local-files';
import { unifiedDiff } from './diff';

const exec = promisify(execFile);
const PAGE_SIZE = 20;
const PATCH_BYTES = 32 * 1024;
const PAGE_BYTES = 128 * 1024;
const STATUS_BYTES = 4 * 1024 * 1024;
type Entry = { path: string; previousPath: string | null; indexStatus: string; worktreeStatus: string };
type Change = Entry & { stagedDiff: string; unstagedDiff: string; untrackedDiff: string; diffTruncated: boolean; omittedReason: string | null };

/** Fixed, read-only Git argv. Ignore inherited Git overrides and disable executable Git helpers. */
async function git(root: string, args: string[], signal: AbortSignal, maxBuffer = STATUS_BYTES) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const result = await exec('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8',
      maxBuffer, timeout: 10_000, killSignal: 'SIGKILL', signal,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: string | number; stdout?: string; stderr?: string };
    if (typeof failed.code === 'number') return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    throw new Error('Workspace Git read failed or exceeded its time/output limit', { cause: error });
  }
}

function statusEntries(status: string, prefix: string): { entries: Entry[]; excludedFileCount: number } {
  const records = status.split('\0'); const entries: Entry[] = []; let excludedFileCount = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!; if (!record) continue;
    const indexStatus = record[0]!, worktreeStatus = record[1]!;
    const fullPath = record.slice(3);
    const previous = /[RC]/.test(indexStatus + worktreeStatus) ? records[++index] : null;
    // Porcelain paths are repository-relative, even for a workspace bound to a subdirectory.
    if (!fullPath.startsWith(prefix) || (previous && !previous.startsWith(prefix))) { excludedFileCount++; continue; }
    const path = fullPath.slice(prefix.length), previousPath = previous ? previous.slice(prefix.length) : null;
    try { validateLocalPath(path); if (previousPath) validateLocalPath(previousPath); }
    catch { excludedFileCount++; continue; }
    entries.push({ path, previousPath, indexStatus, worktreeStatus });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, excludedFileCount };
}

/** A paginated live view of Git changes, independent of Dot's durable write receipts. Never writes or fetches. */
export async function readWorkspaceChanges(root: string, offset = 0, parentSignal?: AbortSignal) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid change offset');
  if (canonicalWorkspace(root) !== root) throw new Error('Workspace root changed');
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], signal);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    if (inside.code !== 0 && !inside.stderr.includes('not a git repository')) throw new Error('Unable to inspect workspace Git repository');
    return { isGitRepository: false, headSha: null, files: [] as Change[], totalFiles: 0, excludedFileCount: 0, offset, nextOffset: null,
      note: 'This workspace is not a Git working tree; no change baseline is available. This does not mean its files are unchanged.' };
  }
  const prefixResult = await git(root, ['rev-parse', '--show-prefix'], signal);
  const headResult = await git(root, ['rev-parse', '--verify', 'HEAD'], signal);
  const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.'];
  const status = await git(root, statusArgs, signal);
  if (prefixResult.code || status.code) throw new Error('Unable to read workspace change list');
  const prefix = prefixResult.stdout.replace(/\n$/, '');
  const { entries, excludedFileCount } = statusEntries(status.stdout, prefix);
  const files: Change[] = []; let remaining = PAGE_BYTES;
  for (const entry of entries.slice(offset, offset + PAGE_SIZE)) {
    const file: Change = { ...entry, stagedDiff: '', unstagedDiff: '', untrackedDiff: '', diffTruncated: false, omittedReason: null };
    const clip = (patch: string) => {
      const bytes = Buffer.from(patch); const count = Math.min(PATCH_BYTES, remaining);
      remaining -= Math.min(count, bytes.length);
      if (bytes.length <= count) return patch;
      file.diffTruncated = true;
      // Do not split a UTF-8 sequence at the response boundary.
      let end = count; while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      return bytes.subarray(0, end).toString('utf8');
    };
    try {
      const current = readSource(root, entry.path);
      if (entry.previousPath) readSource(root, entry.previousPath);
      if (entry.indexStatus === '?' && entry.worktreeStatus === '?') {
        if (current.content === null) throw new Error('Untracked file disappeared; read the change list again');
        const patch = unifiedDiff('', current.content);
        if (patch === null) { file.diffTruncated = true; file.omittedReason = 'New file diff exceeds display limit; use read_dot_file'; }
        else file.untrackedDiff = clip(`--- /dev/null\n+++ b/${entry.path}\n${patch}\n`);
      } else {
        const paths = entry.previousPath ? [entry.path, entry.previousPath] : [entry.path];
        const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/'];
        // Keep index and working-tree changes separate, including staged changes in an unborn repository.
        if (entry.indexStatus !== ' ') {
          const result = await git(root, ['diff', '--cached', ...diffArgs, '--', ...paths], signal, MAX_SOURCE_BYTES * 4);
          if (result.code) throw new Error('Unable to read staged diff');
          file.stagedDiff = clip(result.stdout);
        }
        if (entry.worktreeStatus !== ' ') {
          const result = await git(root, ['diff', ...diffArgs, '--', ...paths], signal, MAX_SOURCE_BYTES * 4);
          if (result.code) throw new Error('Unable to read working-tree diff');
          file.unstagedDiff = clip(result.stdout);
        }
      }
    } catch (error) {
      // Keep a visible changed-file entry when binary, oversized or unsafe content cannot be read.
      file.omittedReason = error instanceof Error ? error.message : 'Diff unavailable';
    }
    files.push(file);
  }
  const finalStatus = await git(root, statusArgs, signal);
  const finalHead = await git(root, ['rev-parse', '--verify', 'HEAD'], signal);
  if (finalStatus.code || finalStatus.stdout !== status.stdout || finalHead.stdout !== headResult.stdout) throw new Error('Workspace Git state changed during the read; read the change list again');
  if (canonicalWorkspace(root) !== root) throw new Error('Workspace root changed');
  return { isGitRepository: true, headSha: headResult.code === 0 ? headResult.stdout.trim() : null,
    files, totalFiles: entries.length, excludedFileCount, offset, nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null,
    note: 'Staged diff compares HEAD to index; unstaged diff compares index to working tree; untracked diff shows new text. Protected paths are excluded. This is a live read, not an atomic snapshot. Follow nextOffset and disclose omitted/truncated diffs. task.localChanges contains only Dot write receipts, not Git changes.' };
}
