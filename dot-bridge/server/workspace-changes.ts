import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { MAX_SOURCE_BYTES } from '../shared/local-files';
import { canonicalWorkspace, readSource, sourceHash, validateLocalPath } from './local-files';
import { unifiedDiff } from './diff';

const exec = promisify(execFile);
const PAGE_SIZE = 20;
const PATCH_BYTES = 32 * 1024;
const PAGE_BYTES = 128 * 1024;
const STATUS_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 5000;
const SNAPSHOT_FORMAT = 2;
type Blob = { mode: string; oid: string };
type DiffKind = 'staged' | 'unstaged' | 'untracked';
export type WorkspaceReviewOptions = { snapshotId?: string | null; path?: string | null; diffKind?: DiffKind | null; diffOffset?: number; diffSha256?: string | null; allowedPaths?: readonly string[] | null; authorizePaths?: (paths: string[]) => void };
type Entry = { path: string; previousPath: string | null; indexStatus: string; worktreeStatus: string; baselineOmitted: boolean; conflicted: boolean; indexFlag: string | null };
type Change = Entry & { stagedDiff: string; unstagedDiff: string; untrackedDiff: string; diffTruncated: boolean; nextDiffs: Array<{ kind: DiffKind; offset: number; sha256: string }>; omittedReason: string | null };
export class WorkspaceSnapshotChanged extends Error { constructor() { super('Workspace snapshot changed; restart the review from offset 0 without a snapshotId'); } }

/** Fixed read-only argv; no shell, executable Git helpers, inherited Git overrides or index writes. */
async function git(root: string, args: string[], signal: AbortSignal, maxBuffer = STATUS_BYTES) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const result = await exec('git', ['--no-replace-objects', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer',
      maxBuffer, timeout: 10_000, killSignal: 'SIGKILL', signal,
    });
    return { code: 0, stdout: result.stdout.toString('utf8'), bytes: result.stdout, stderr: result.stderr.toString('utf8') };
  } catch (error) {
    const failed = error as { code?: string | number; stdout?: Buffer; stderr?: Buffer };
    if (typeof failed.code === 'number') return { code: failed.code, stdout: failed.stdout?.toString('utf8') ?? '', bytes: failed.stdout ?? Buffer.alloc(0), stderr: failed.stderr?.toString('utf8') ?? '' };
    throw new Error('Workspace Git read failed or exceeded its time/output limit', { cause: error });
  }
}

function safePath(path: string): boolean { try { validateLocalPath(path); return true; } catch { return false; } }
function statusEntries(status: string, prefix: string, allowedPaths: readonly string[] | null) {
  const records = status.split('\0'); const entries: Entry[] = []; let excludedFileCount = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!; if (!record) continue;
    const fullPath = record.slice(3).replace(/\/$/, ''), previous = /[RC]/.test(record.slice(0, 2)) ? records[++i] ?? null : null;
    const inside = fullPath.startsWith(prefix) && (!allowedPaths || allowedPaths.includes(fullPath.slice(prefix.length)));
    const oldInside = previous?.startsWith(prefix) && (!allowedPaths || allowedPaths.includes(previous.slice(prefix.length)));
    if (!inside && oldInside && safePath(previous!.slice(prefix.length))) {
      entries.push({ path: previous!.slice(prefix.length), previousPath: null, indexStatus: 'D', worktreeStatus: ' ', baselineOmitted: true, conflicted: false, indexFlag: null }); continue;
    }
    if (!inside || !safePath(fullPath.slice(prefix.length))) { excludedFileCount++; continue; }
    const path = fullPath.slice(prefix.length), previousPath = previous && oldInside ? previous.slice(prefix.length) : null;
    // A protected origin remains excluded. An origin outside the workspace is never exposed.
    if (previousPath && !safePath(previousPath)) { excludedFileCount++; continue; }
    entries.push({ path, previousPath, indexStatus: record[0]!, worktreeStatus: record[1]!, baselineOmitted: !!previous && !oldInside, conflicted: record.slice(0, 2).includes('U') || ['AA', 'DD'].includes(record.slice(0, 2)), indexFlag: null });
  }
  return { entries, excludedFileCount };
}

function inspectSource(root: string, path: string) {
  try { const source = readSource(root, path); return { key: JSON.stringify([source.sha256, source.mode]), source, error: null }; }
  catch (error) { const message = error instanceof Error ? error.message : 'Source unavailable'; return { key: `error:${message}`, source: null, error: message }; }
}

async function scan(root: string, prefix: string, signal: AbortSignal, options: WorkspaceReviewOptions, allowedPaths: readonly string[] | null) {
  const pathspecs = allowedPaths ? [...allowedPaths] : ['.'];
  options.authorizePaths?.([]);
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], signal);
  const status = await git(root, ['status', ...(allowedPaths ? ['--no-renames'] : []), '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', ...pathspecs], signal);
  const index = await git(root, ['ls-files', '--stage', '-z', '--full-name', '--', ...pathspecs], signal);
  const flags = await git(root, ['ls-files', '-v', '-z', '--full-name', '--', ...pathspecs], signal);
  if (status.code || index.code || flags.code) throw new Error('Unable to read workspace Git snapshot');
  const { entries, excludedFileCount } = statusEntries(status.stdout, prefix, allowedPaths);
  const indexed = new Map<string, Blob>(), conflictOurs = new Map<string, Blob>();
  for (const record of index.stdout.split('\0')) {
    const match = /^(\d+) ([a-f0-9]{40,64}) ([0-3])\t(.*)$/.exec(record);
    if (!match || !match[4]!.startsWith(prefix)) continue;
    const path = match[4]!.slice(prefix.length);
    if (!safePath(path) || (allowedPaths && !allowedPaths.includes(path))) continue;
    if (match[3] === '0') indexed.set(path, { mode: match[1]!, oid: match[2]! });
    if (match[3] === '2') conflictOurs.set(path, { mode: match[1]!, oid: match[2]! });
  }
  const committed = new Map<string, Blob>();
  if (head.code === 0) {
    const tree = await git(root, ['ls-tree', '-r', '-z', '--full-tree', head.stdout.trim(), '--', ...pathspecs.map(path => prefix + path)], signal);
    if (tree.code) throw new Error('Unable to read captured HEAD tree');
    for (const record of tree.stdout.split('\0')) {
      const match = /^(\d+) (?:blob|commit) ([a-f0-9]{40,64})\t(.*)$/.exec(record);
      if (!match || !match[3]!.startsWith(prefix)) continue;
      const path = match[3]!.slice(prefix.length);
      if (safePath(path) && (!allowedPaths || allowedPaths.includes(path))) committed.set(path, { mode: match[1]!, oid: match[2]! });
    }
  }
  const hidden = new Map<string, string>();
  for (const record of flags.stdout.split('\0')) {
    if (!record || (!/[a-z]/.test(record[0]!) && record[0] !== 'S')) continue;
    const fullPath = record.slice(2);
    if (fullPath.startsWith(prefix) && safePath(fullPath.slice(prefix.length)) && (!allowedPaths || allowedPaths.includes(fullPath.slice(prefix.length)))) hidden.set(fullPath.slice(prefix.length), record[0] === 'S' || record[0] === 's' ? 'skip-worktree' : 'assume-unchanged');
  }
  const paths = new Set([...entries.flatMap(entry => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]), ...hidden.keys()]);
  if (paths.size > MAX_SNAPSHOT_FILES) throw new Error('Workspace review exceeds the 5000-file snapshot limit; narrow the workspace');
  const sources = new Map<string, string>(), byPath = new Map(entries.map(entry => [entry.path, entry])); let hiddenUnverifiedCount = 0, unverifiedFileCount = 0;
  for (const path of paths) {
    signal.throwIfAborted();
    if (sources.size % 32 === 0) await setImmediate(undefined, { signal });
    options.authorizePaths?.([path]);
    const current = inspectSource(root, path); sources.set(path, current.key);
    if (current.error) unverifiedFileCount++;
    const flag = hidden.get(path), baseline = indexed.get(path);
    if (!flag) continue;
    // Sparse checkout absence is intentional; never synthesize a deletion for absent skip-worktree files.
    if (!current.source || !baseline || !/^100(644|755)$/.test(baseline.mode) || (flag === 'skip-worktree' && current.source.content === null)) { hiddenUnverifiedCount++; continue; }
    const existing = byPath.get(path);
    if (existing) existing.indexFlag = flag;
    const content = current.source.content;
    const oid = content === null ? null : createHash(baseline.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
    if (oid !== baseline.oid || (current.source.mode !== null && !!(current.source.mode & 0o100) !== (baseline.mode === '100755'))) {
      if (existing) existing.worktreeStatus = content === null ? 'D' : 'M';
      else entries.push({ path, previousPath: null, indexStatus: ' ', worktreeStatus: content === null ? 'D' : 'M', baselineOmitted: false, conflicted: false, indexFlag: flag });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const snapshotId = sourceHash(JSON.stringify({ format: SNAPSHOT_FORMAT, scope: allowedPaths, root, prefix, head: [head.code, head.stdout], index: index.stdout, status: status.stdout, flags: flags.stdout, sources: [...sources].sort(([a], [b]) => a.localeCompare(b)) }));
  return { snapshotId, headSha: head.code === 0 ? head.stdout.trim() : null, entries, indexed, committed, conflictOurs, sources, excludedFileCount, hiddenUnverifiedCount, unverifiedFileCount };
}

function patchPath(path: string) { return JSON.stringify(path); }

/** Deterministic patches from captured inputs: never consult mutable Git diff configuration. */
function textPatch(path: string, before: string | null, after: string | null, oldMode = '100644', newMode = '100644') {
  if (before === after && (before === null || oldMode === newMode)) return '';
  const aPath = patchPath(`a/${path}`), bPath = patchPath(`b/${path}`);
  const out = [`diff --git ${aPath} ${bPath}`, ...(before === null ? [`new file mode ${newMode}`] : after === null ? [`deleted file mode ${oldMode}`] : oldMode !== newMode ? [`old mode ${oldMode}`, `new mode ${newMode}`] : [])];
  if (before === after) return out.join('\n') + '\n';
  // Empty additions/deletions need only the mode header.
  if (!(before ?? '') && !(after ?? '')) return out.join('\n') + '\n';
  out.push(`--- ${before === null ? '/dev/null' : aPath}`, `+++ ${after === null ? '/dev/null' : bPath}`);
  const hunk = before !== null && after !== null && !before.includes('\r') && !after.includes('\r') && before.endsWith('\n') && after.endsWith('\n') ? unifiedDiff(before, after) : null;
  if (hunk !== null) out.push(hunk);
  else {
    const rows = (text: string) => text ? (text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')) : [];
    const a = rows(before ?? ''), b = rows(after ?? '');
    out.push(`@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`);
    a.forEach(line => out.push('-' + line)); if (before && !before.endsWith('\n')) out.push('\\ No newline at end of file');
    b.forEach(line => out.push('+' + line)); if (after && !after.endsWith('\n')) out.push('\\ No newline at end of file');
  }
  return out.join('\n') + '\n';
}

async function readBlob(root: string, baseline: Blob | undefined, signal: AbortSignal): Promise<string | null> {
  if (!baseline) return null;
  if (!/^100(644|755)$/.test(baseline.mode)) throw new Error('Git baseline is not a regular source file');
  const blob = await git(root, ['cat-file', 'blob', baseline.oid], signal, MAX_SOURCE_BYTES + 1);
  if (blob.code || blob.bytes.length > MAX_SOURCE_BYTES) throw new Error('Git baseline unavailable or exceeds the source limit');
  const oid = createHash(baseline.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${blob.bytes.length}\0`).update(blob.bytes).digest('hex');
  if (oid !== baseline.oid) throw new WorkspaceSnapshotChanged();
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob.bytes);
  if (content.includes('\0')) throw new Error('Git baseline is binary');
  return content;
}

/** Bounded, validated live snapshot. Continuations require its identity; reread hashes before editing. */
export async function readWorkspaceChanges(root: string, offset = 0, parentSignal?: AbortSignal, options: WorkspaceReviewOptions = {}) {
  const allowedPaths = options.allowedPaths ? [...new Set(options.allowedPaths)].sort() : null;
  if (allowedPaths) { if (!allowedPaths.length) throw new Error('Workspace review has no authorized paths'); allowedPaths.forEach(path => validateLocalPath(path)); }
  const path = options.path ?? null, diffKind = options.diffKind ?? null, diffOffset = options.diffOffset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid change offset');
  if (!Number.isInteger(diffOffset) || diffOffset < 0 || diffOffset > STATUS_BYTES || (diffOffset && (!path || !diffKind))) throw new Error('A diff continuation requires path and diffKind');
  if ((offset > 0 || path || diffOffset > 0) && !options.snapshotId) throw new Error('A continuation requires the snapshotId from the first page');
  if ((path && offset) || (diffKind && !path)) throw new Error('A single-file diff requires path and offset 0');
  if (path) { validateLocalPath(path); options.authorizePaths?.([path]); if (allowedPaths && !allowedPaths.includes(path)) throw new Error('Workspace review permission required for this path'); }
  if (diffOffset && !options.diffSha256) throw new Error('A diff continuation requires diffSha256 from nextDiffs');
  if (canonicalWorkspace(root) !== root) throw new Error('Workspace root changed');
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], signal);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    if (inside.code !== 0 && !inside.stderr.includes('not a git repository')) throw new Error('Unable to inspect workspace Git repository');
    if (options.snapshotId || offset || path) throw new WorkspaceSnapshotChanged();
    return { isGitRepository: false, headSha: null, snapshotId: null, scopeLimited: allowedPaths !== null, files: [] as Change[], totalFiles: 0, excludedFileCount: 0, hiddenUnverifiedCount: 0, unverifiedFileCount: 0, offset, nextOffset: null,
      note: 'This workspace is not a Git working tree; no change baseline is available. This does not mean its files are unchanged.' };
  }
  const prefixResult = await git(root, ['rev-parse', '--show-prefix'], signal);
  if (prefixResult.code) throw new Error('Unable to read workspace prefix');
  const prefix = prefixResult.stdout.replace(/\n$/, ''), initial = await scan(root, prefix, signal, options, allowedPaths);
  if (options.snapshotId && options.snapshotId !== initial.snapshotId) throw new WorkspaceSnapshotChanged();
  const selected = path ? initial.entries.filter(entry => entry.path === path) : initial.entries.slice(offset, offset + PAGE_SIZE);
  if (path && !selected.length) throw new Error('Path is not in this workspace change snapshot');
  const files: Change[] = []; let remaining = PAGE_BYTES;
  for (const entry of selected) {
    const file: Change = { ...entry, stagedDiff: '', unstagedDiff: '', untrackedDiff: '', diffTruncated: false, nextDiffs: [], omittedReason: null };
    const clip = (kind: DiffKind, patch: string) => {
      if (diffKind && kind !== diffKind) return '';
      const sha256 = sourceHash(patch);
      if (diffKind === kind && options.diffSha256 && options.diffSha256 !== sha256) throw new WorkspaceSnapshotChanged();
      const bytes = Buffer.from(patch), start = diffKind ? diffOffset : 0;
      if (start > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)) throw new Error('Invalid UTF-8 diff offset');
      let end = Math.min(bytes.length, start + Math.min(PATCH_BYTES, remaining));
      while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      remaining -= end - start;
      if (end < bytes.length) { file.diffTruncated = true; file.nextDiffs.push({ kind, offset: end, sha256 }); }
      return bytes.subarray(start, end).toString('utf8');
    };
    // Authorization failures must abort the read, never become a per-file omission.
    const paths = entry.previousPath ? [entry.path, entry.previousPath] : [entry.path];
    options.authorizePaths?.(paths);
    try {
      const current = inspectSource(root, entry.path);
      if (current.key !== initial.sources.get(entry.path)) throw new WorkspaceSnapshotChanged();
      if (!current.source) throw new Error(current.error!);
      if (entry.previousPath && inspectSource(root, entry.previousPath).key !== initial.sources.get(entry.previousPath)) throw new WorkspaceSnapshotChanged();
      if (entry.indexStatus === '?' && entry.worktreeStatus === '?') {
        if (current.source.content === null) throw new WorkspaceSnapshotChanged();
        file.untrackedDiff = clip('untracked', textPatch(entry.path, null, current.source.content, '100644', current.source.mode! & 0o100 ? '100755' : '100644'));
      } else {
        if (entry.indexStatus !== ' ' && (!diffKind || diffKind === 'staged')) {
          if (entry.conflicted) file.omittedReason = 'Unmerged index: no single staged baseline; unstaged diff uses the stage-2 (ours) blob when available';
          else {
            let patch = '';
            for (const path of paths) {
              options.authorizePaths?.([path]);
              const head = initial.committed.get(path), index = initial.indexed.get(path);
              const before = await readBlob(root, head, signal);
              options.authorizePaths?.([path]);
              const after = await readBlob(root, index, signal);
              patch += textPatch(path, before, after, head?.mode, index?.mode);
            }
            file.stagedDiff = clip('staged', patch);
          }
        }
        if (entry.worktreeStatus !== ' ' && (!diffKind || diffKind === 'unstaged')) {
          options.authorizePaths?.([entry.path]);
          const index = initial.indexed.get(entry.path) ?? initial.conflictOurs.get(entry.path);
          const before = await readBlob(root, index, signal);
          const mode = current.source.mode !== null && current.source.mode & 0o100 ? '100755' : '100644';
          file.unstagedDiff = clip('unstaged', textPatch(entry.path, before, current.source.content, index?.mode, mode));
          if (entry.conflicted) file.omittedReason = 'Unmerged index: no single staged baseline; unstaged diff uses the stage-2 (ours) blob when available';
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceSnapshotChanged || signal.aborted || (error as { code?: string }).code === 'permission-required') throw error;
      file.omittedReason = error instanceof Error ? error.message : 'Diff unavailable';
    }
    files.push(file);
  }
  const final = await scan(root, prefix, signal, options, allowedPaths);
  if (final.snapshotId !== initial.snapshotId) throw new WorkspaceSnapshotChanged();
  if (canonicalWorkspace(root) !== root) throw new Error('Workspace root changed');
  return { isGitRepository: true, headSha: initial.headSha, snapshotId: initial.snapshotId, scopeLimited: allowedPaths !== null, files, totalFiles: initial.entries.length,
    excludedFileCount: initial.excludedFileCount, hiddenUnverifiedCount: initial.hiddenUnverifiedCount, unverifiedFileCount: initial.unverifiedFileCount, offset,
    nextOffset: !path && offset + PAGE_SIZE < initial.entries.length ? offset + PAGE_SIZE : null,
    note: (allowedPaths ? 'This review is limited to explicitly authorized file paths; other workspace files have not been inspected. ' : '') + 'Staged diff compares HEAD to index; unstaged diff compares index to disk; untracked diff shows new text. Pass snapshotId for every nextOffset or nextDiffs continuation. Continue a truncated part with path, diffKind and its returned byte diffOffset and sha256 as diffSha256. If the snapshot changes, restart at offset 0 without snapshotId. Protected paths are excluded; disclose omitted diffs, unverified/hidden files and cross-workspace rename baselines. All text patches, including assume-unchanged and present skip-worktree files, compare raw source bytes without changing Git flags. This validates live reads but does not lock external editors. Zero files means no detected disk/index changes within these limits, not no unsaved buffers or branch commits. task.localChanges contains only Dot write receipts.' };
}
