import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { todoError } from '../shared/errors';
import { branchSchema, shaSchema, type TaskDiff } from '../shared/schema';
import { todoDataDir } from './store';

const exec = promisify(execFile);
const PATCH_LIMIT = 48_000;
/** The collaboration host names a run's branch after the first 24 hex digits of its id. */
const HOST_BRANCH = /^director\/[0-9a-f]{24}$/;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRun = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<GitResult>;

export const defaultGitRun: GitRun = async (cwd, args, env) => {
  try {
    const result = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
    if (typeof failed.code === 'number') {
      return { code: failed.code, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
    }
    throw error;
  }
};

const identity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'paseo-todo',
  GIT_AUTHOR_EMAIL: 'paseo-todo@localhost',
  GIT_COMMITTER_NAME: 'paseo-todo',
  GIT_COMMITTER_EMAIL: 'paseo-todo@localhost',
};

export interface BindingSnapshot {
  head: string;
  tree: string;
  clean: boolean;
  targetHead: string;
}

export interface EnsureWorktreeInput {
  root: string;
  taskId: string;
  branch: string;
  targetBranch: string;
  existingPath: string | null;
}

export interface PrepareMergeInput {
  root: string;
  worktree: string;
  taskBranch: string;
  targetBranch: string;
  expectedTargetHead: string;
  resultCommit: string;
  resultTree: string;
  message: string;
}

export interface PrepareOk {
  ok: true;
  mergeCommit: string;
  checkout: string | null;
  root: string;
  worktree: string;
  taskBranch: string;
  targetBranch: string;
  expectedTargetHead: string;
  resultCommit: string;
  resultTree: string;
}

export interface GitFailure {
  ok: false;
  reason: 'conflict' | 'dirty' | 'stale-target' | 'stale-result' | 'verify-failed';
  detail: string;
}

export type PrepareResult = PrepareOk | GitFailure;
export type ApplyResult = { ok: true; mergeCommit: string; method: 'update-ref' | 'ff-only' } | GitFailure;

export interface GitPort {
  resolveRepository(path: string): Promise<string>;
  listBranches(root: string): Promise<{ branches: string[]; head: string | null }>;
  branchExists(root: string, branch: string): Promise<boolean>;
  ensureWorktree(input: EnsureWorktreeInput): Promise<{ worktree: string; branch: string; baseCommit: string }>;
  capture(input: { root: string; worktree: string; branch: string; message: string }): Promise<{ commit: string; tree: string }>;
  snapshot(input: { root: string; worktree: string; branch: string; targetBranch: string }): Promise<BindingSnapshot>;
  readTargetHead(root: string, branch: string): Promise<string>;
  diff(input: { root: string; worktree: string; branch: string; from: string; to: string | null }): Promise<TaskDiff>;
  prepareMerge(input: PrepareMergeInput): Promise<PrepareResult>;
  applyMerge(input: PrepareOk): Promise<ApplyResult>;
  removeWorktree(input: { root: string; worktree: string; branch: string }): Promise<void>;
  deleteBranch(input: { root: string; branch: string }): Promise<void>;
  deleteMergedBranch(input: { root: string; branch: string; expectedHead: string; targetBranch: string }): Promise<void>;
}

interface WorktreeRow {
  path: string;
  head: string;
  branch: string | null;
}

/** Task worktrees live under the plugin data dir, outside the repository, so the user's checkout is not switched. */
export function createGit(options: { run?: GitRun; worktreeRoot?: string } = {}): GitPort {
  const run = options.run ?? defaultGitRun;
  const worktreeRoot = options.worktreeRoot ?? join(todoDataDir(), 'worktrees');

  async function text(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
    return run(cwd, args, env);
  }

  async function rev(cwd: string, ref: string): Promise<string> {
    const result = await text(cwd, ['rev-parse', ref]);
    const value = result.stdout.trim();
    if (result.code !== 0 || !shaSchema.safeParse(value).success) {
      throw new Error((result.stderr || result.stdout || `无法解析 ${ref}`).trim());
    }
    return value;
  }

  /** One rev-parse for several refs: one output line each, in order; a short or non-sha answer is an error. */
  async function revs(cwd: string, refs: string[]): Promise<string[]> {
    const result = await text(cwd, ['rev-parse', ...refs]);
    const lines = result.stdout.trim().split('\n').map(line => line.trim());
    if (result.code !== 0 || lines.length !== refs.length || lines.some(line => !shaSchema.safeParse(line).success)) {
      throw new Error((result.stderr || result.stdout || `无法解析 ${refs.join(' ')}`).trim());
    }
    return lines;
  }

  async function porcelain(cwd: string): Promise<string> {
    const result = await text(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (result.code !== 0) throw new Error((result.stderr || '无法读取工作树状态').trim());
    return result.stdout;
  }

  function parseWorktrees(raw: string): WorktreeRow[] {
    const rows: WorktreeRow[] = [];
    let current: { path?: string; head?: string; branch: string | null } | null = null;
    const flush = () => {
      if (current?.path && current.head) rows.push({ path: current.path, head: current.head, branch: current.branch });
      current = null;
    };
    for (const line of raw.split('\n')) {
      if (!line.trim()) { flush(); continue; }
      if (line.startsWith('worktree ')) {
        flush();
        current = { path: line.slice('worktree '.length), branch: null };
      } else if (line.startsWith('HEAD ') && current) current.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ') && current) current.branch = line.slice('branch '.length).trim();
      else if (line === 'detached' && current) current.branch = null;
    }
    flush();
    return rows;
  }

  async function worktrees(root: string): Promise<WorktreeRow[]> {
    const result = await text(root, ['worktree', 'list', '--porcelain']);
    if (result.code !== 0) throw new Error((result.stderr || '无法列出工作树').trim());
    return parseWorktrees(result.stdout);
  }

  async function reuse(path: string, branch: string) {
    try {
      if (!existsSync(path)) return null;
      const topOut = await text(path, ['rev-parse', '--show-toplevel']);
      if (topOut.code !== 0) return null;
      const top = await realpath(topOut.stdout.trim());
      if (top !== await realpath(path)) return null;
      const current = await text(path, ['branch', '--show-current']);
      if (current.code !== 0 || !await holdsTaskBranch(path, current.stdout.trim(), branch)) return null;
      return { worktree: top, branch, baseCommit: await rev(path, 'HEAD') };
    } catch {
      return null;
    }
  }

  function clip(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
  }

  const OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

  /** One rev-parse resolves every marker path, in order; a short answer means the output cannot be trusted. */
  async function operationInProgress(cwd: string): Promise<string | null> {
    const located = await text(cwd, ['rev-parse', ...OPERATION_MARKERS.flatMap(name => ['--git-path', name])]);
    if (located.code !== 0) return null;
    const lines = located.stdout.trim().split('\n').map(line => line.trim());
    if (lines.length !== OPERATION_MARKERS.length) {
      throw new Error((located.stderr || located.stdout || '无法确认仓库状态').trim());
    }
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index];
      if (existsSync(isAbsolute(raw) ? raw : join(cwd, raw))) return OPERATION_MARKERS[index];
    }
    return null;
  }

  async function commonDir(cwd: string): Promise<string> {
    const result = await text(cwd, ['rev-parse', '--git-common-dir']);
    if (result.code !== 0) throw new Error((result.stderr || '无法确认 git common-dir').trim());
    const raw = result.stdout.trim();
    return realpath(isAbsolute(raw) ? raw : join(cwd, raw));
  }

  /**
   * A `local` collaboration run switches the task worktree to the host's own `director/<run>` branch
   * and asserts that branch until the user accepts. It still holds the task while both tips are equal.
   */
  async function holdsTaskBranch(cwd: string, current: string, branch: string): Promise<boolean> {
    if (current === branch) return true;
    if (!HOST_BRANCH.test(current)) return false;
    try {
      const [head, tip] = await revs(cwd, ['HEAD', `refs/heads/${branch}`]);
      return head === tip;
    } catch {
      return false;
    }
  }

  /** A commit on the host branch moves only that branch. Advance the task branch to it, from the tip they shared. */
  async function followHostBranch(root: string, worktree: string, branch: string, before: string): Promise<void> {
    const current = await text(worktree, ['branch', '--show-current']);
    if (current.code !== 0 || current.stdout.trim() === branch) return;
    const [head, parent] = await revs(worktree, ['HEAD', 'HEAD^']);
    if (parent !== before) throw todoError('worktree-moved', '协作分支的提交没有接在任务分支之后');
    const moved = await text(root, ['update-ref', `refs/heads/${branch}`, head, before]);
    if (moved.code !== 0) throw todoError('worktree-moved', clip(moved.stderr || moved.stdout || '任务分支没有跟上协作分支'));
  }

  async function assertTaskCheckout(root: string, worktree: string, branch: string): Promise<void> {
    const topOut = await text(worktree, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    if (topOut.code !== 0) throw todoError('worktree-moved', '任务目录不是 git 工作树');
    const lines = topOut.stdout.trim().split('\n').map(line => line.trim());
    if (lines.length !== 2) throw todoError('worktree-moved', '任务目录不是 git 工作树');
    if (await realpath(lines[0]) !== await realpath(worktree)) throw todoError('worktree-moved', '任务目录不是工作树根');
    const common = await realpath(isAbsolute(lines[1]) ? lines[1] : join(worktree, lines[1]));
    if (common !== await commonDir(root)) throw todoError('worktree-moved', '任务目录不属于预期仓库');
    const current = await text(worktree, ['branch', '--show-current']);
    if (current.code !== 0 || !await holdsTaskBranch(worktree, current.stdout.trim(), branch)) throw todoError('worktree-moved', '任务目录当前分支不是任务分支');
    const busy = await operationInProgress(worktree);
    if (busy) throw todoError('worktree-moved', `任务工作树正在进行 ${busy}`);
  }

  async function preflight(input: Omit<PrepareMergeInput, 'message'>): Promise<{ checkout: string | null } | GitFailure> {
    try { await assertTaskCheckout(input.root, input.worktree, input.taskBranch); }
    catch (error) { return { ok: false, reason: 'verify-failed', detail: clip(error instanceof Error ? error.message : String(error)) }; }
    let actualTree = '';
    try { actualTree = await rev(input.root, `${input.resultCommit}^{tree}`); }
    catch (error) { return { ok: false, reason: 'stale-result', detail: clip(error instanceof Error ? error.message : String(error)) }; }
    if (actualTree !== input.resultTree) return { ok: false, reason: 'stale-result', detail: '成果 tree 与绑定不一致' };
    let snap: BindingSnapshot;
    try { snap = await snapshot({ root: input.root, worktree: input.worktree, branch: input.taskBranch, targetBranch: input.targetBranch }); }
    catch (error) { return { ok: false, reason: 'verify-failed', detail: clip(error instanceof Error ? error.message : String(error)) }; }
    if (snap.head !== input.resultCommit || snap.tree !== input.resultTree || !snap.clean) {
      return { ok: false, reason: 'stale-result', detail: '任务工作树已偏离绑定的提交' };
    }
    if (snap.targetHead !== input.expectedTargetHead) return { ok: false, reason: 'stale-target', detail: '目标分支 HEAD 已变化' };
    const checkouts = (await worktrees(input.root)).filter(row => row.branch === `refs/heads/${input.targetBranch}`);
    if (checkouts.length > 1) return { ok: false, reason: 'verify-failed', detail: '目标分支在多个工作树检出' };
    const checkout = checkouts[0];
    if (!checkout) return { checkout: null };
    const busy = await operationInProgress(checkout.path);
    if (busy) return { ok: false, reason: 'verify-failed', detail: `目标工作树正在进行 ${busy}，已拒绝合并` };
    const dirty = (await porcelain(checkout.path)).trim();
    if (dirty) return { ok: false, reason: 'dirty', detail: '目标分支工作树不干净，已拒绝合并' };
    if (checkout.head !== input.expectedTargetHead) return { ok: false, reason: 'stale-target', detail: '检出的目标分支已不是绑定的 HEAD' };
    return { checkout: checkout.path };
  }

  async function snapshot(input: { root: string; worktree: string; branch: string; targetBranch: string }): Promise<BindingSnapshot> {
    await assertTaskCheckout(input.root, input.worktree, input.branch);
    const [head, tree] = await revs(input.worktree, ['HEAD', 'HEAD^{tree}']);
    const clean = (await porcelain(input.worktree)).trim() === '';
    const targetHead = await rev(input.root, `refs/heads/${input.targetBranch}`);
    return { head, tree, clean, targetHead };
  }

  return {
    async resolveRepository(path: string) {
      const result = await text(path, ['rev-parse', '--show-toplevel']);
      if (result.code !== 0) throw todoError('not-git', clip(result.stderr || result.stdout));
      return realpath(result.stdout.trim());
    },
    async listBranches(root: string) {
      const result = await text(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      if (result.code !== 0) throw new Error(clip(result.stderr || '无法列出分支'));
      const branches = result.stdout.split('\n').map(line => line.trim()).filter(line => branchSchema.safeParse(line).success);
      const head = await text(root, ['symbolic-ref', '--short', 'HEAD']);
      const current = head.code === 0 ? head.stdout.trim() : null;
      return { branches, head: current && branchSchema.safeParse(current).success ? current : null };
    },
    async branchExists(root: string, branch: string) {
      if (!branchSchema.safeParse(branch).success) return false;
      const result = await text(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return result.code === 0;
    },
    /** Reuse a checkout of the task branch, or create the branch from the target and add a worktree. */
    async ensureWorktree(input) {
      if (!branchSchema.safeParse(input.branch).success || !branchSchema.safeParse(input.targetBranch).success) {
        throw todoError('branch-invalid');
      }
      const desired = input.existingPath ?? join(worktreeRoot, input.taskId);
      if (input.existingPath) {
        const reused = await reuse(input.existingPath, input.branch);
        if (reused) return reused;
        if (existsSync(input.existingPath)) throw new Error('已有任务工作树无法安全复用');
      }
      await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
      const branchRef = `refs/heads/${input.branch}`;
      if (await this.branchExists(input.root, input.branch)) {
        const found = (await worktrees(input.root)).filter(row => row.branch === branchRef);
        if (found.length > 1) throw new Error('任务分支在多个工作树检出');
        if (found.length === 1) {
          const reused = await reuse(found[0].path, input.branch);
          if (reused) return reused;
        }
        const added = await text(input.root, ['worktree', 'add', desired, input.branch]);
        if (added.code !== 0) throw new Error(clip(added.stderr || added.stdout || '无法添加工作树'));
      } else {
        const start = await rev(input.root, `refs/heads/${input.targetBranch}`);
        const added = await text(input.root, ['worktree', 'add', '-b', input.branch, desired, start]);
        if (added.code !== 0) throw new Error(clip(added.stderr || added.stdout || '无法创建任务分支'));
      }
      const top = await realpath((await text(desired, ['rev-parse', '--show-toplevel'])).stdout.trim());
      return { worktree: top, branch: input.branch, baseCommit: await rev(top, 'HEAD') };
    },
    /** Commit a dirty task worktree, then refuse unless that commit is the task branch tip. */
    async capture(input) {
      await assertTaskCheckout(input.root, input.worktree, input.branch);
      if ((await porcelain(input.worktree)).trim()) {
        await assertTaskCheckout(input.root, input.worktree, input.branch);
        const added = await text(input.worktree, ['add', '-A', '--', '.']);
        if (added.code !== 0) throw new Error(clip(added.stderr || '无法暂存任务成果'));
        await assertTaskCheckout(input.root, input.worktree, input.branch);
        const before = await rev(input.root, `refs/heads/${input.branch}`);
        const committed = await text(input.worktree, ['commit', '-m', input.message], identity);
        if (committed.code !== 0) throw new Error(clip(committed.stderr || committed.stdout || '无法提交任务成果'));
        await followHostBranch(input.root, input.worktree, input.branch, before);
      }
      await assertTaskCheckout(input.root, input.worktree, input.branch);
      const [commit, tree] = await revs(input.worktree, ['HEAD', 'HEAD^{tree}']);
      const branchHead = await rev(input.root, `refs/heads/${input.branch}`);
      if (branchHead !== commit) throw todoError('worktree-moved', '提交没有落在任务分支上');
      return { commit, tree };
    },
    snapshot,
    readTargetHead(root, branch) {
      return rev(root, `refs/heads/${branch}`);
    },
    async diff(input) {
      await assertTaskCheckout(input.root, input.worktree, input.branch);
      // Against a result commit, diff from the merge-base (`a...b`): commits that reached the target after the task
      // branched would otherwise show up as reverted by the task, which the merge will not do.
      const range = input.to ? [`${input.from}...${input.to}`] : [input.from];
      const args = ['diff', '--find-renames', '--no-ext-diff', ...range];
      const names = await text(input.worktree, ['diff', '--name-only', '-z', ...range]);
      const patch = await text(input.worktree, args);
      if (names.code !== 0 || patch.code !== 0) throw new Error(clip(patch.stderr || names.stderr || '无法读取 diff'));
      const full = patch.stdout;
      return {
        files: names.stdout.split('\0').filter(Boolean),
        patch: full.length > PATCH_LIMIT ? full.slice(0, PATCH_LIMIT) : full,
        truncated: full.length > PATCH_LIMIT,
      };
    },
    /** Build the merge commit with merge-tree. Does not check out or move the user's branch. */
    async prepareMerge(input) {
      const ready = await preflight(input);
      if ('ok' in ready) return ready;
      const merged = await text(input.root, ['merge-tree', '--write-tree', input.expectedTargetHead, input.resultCommit]);
      if (merged.code !== 0) return { ok: false, reason: 'conflict', detail: clip(merged.stdout || merged.stderr || '合并存在冲突') };
      const tree = merged.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (!shaSchema.safeParse(tree).success) return { ok: false, reason: 'verify-failed', detail: 'merge-tree 没有返回目录树' };
      const committed = await text(input.root, ['commit-tree', tree, '-p', input.expectedTargetHead, '-p', input.resultCommit, '-m', input.message], identity);
      const mergeCommit = committed.stdout.trim();
      if (committed.code !== 0 || !shaSchema.safeParse(mergeCommit).success) {
        return { ok: false, reason: 'verify-failed', detail: clip(committed.stderr || '无法创建合并提交') };
      }
      return {
        ok: true,
        mergeCommit,
        checkout: ready.checkout,
        root: input.root,
        worktree: input.worktree,
        taskBranch: input.taskBranch,
        targetBranch: input.targetBranch,
        expectedTargetHead: input.expectedTargetHead,
        resultCommit: input.resultCommit,
        resultTree: input.resultTree,
      };
    },
    /** Only the task's own worktree, on its own branch; without --force git keeps any uncommitted or untracked file. */
    async removeWorktree(input) {
      if (!existsSync(input.worktree)) {
        await text(input.root, ['worktree', 'prune']);
        return;
      }
      await assertTaskCheckout(input.root, input.worktree, input.branch);
      const removed = await text(input.root, ['worktree', 'remove', input.worktree]);
      if (removed.code !== 0) throw new Error(clip(removed.stderr || removed.stdout || '无法移除任务工作树'));
    },
    /**
     * Force-deletes a plugin-made branch whose task is being removed for good, merged or not — unlike
     * deleteMergedBranch there is no kept record to retry from. Refuses a branch a worktree still has checked out.
     */
    async deleteBranch(input) {
      if (!input.branch.startsWith('paseo-todo/') || !branchSchema.safeParse(input.branch).success) {
        throw new Error(`只删除插件创建的 paseo-todo/ 任务分支:${input.branch}`);
      }
      if (!await this.branchExists(input.root, input.branch)) return;
      const ref = `refs/heads/${input.branch}`;
      if ((await worktrees(input.root)).some(row => row.branch === ref)) throw new Error('任务分支仍在某个工作树检出,没有删除');
      const deleted = await text(input.root, ['update-ref', '-d', ref]);
      if (deleted.code !== 0) throw new Error(clip(deleted.stderr || deleted.stdout || '无法删除任务分支'));
    },
    /**
     * Deletes a plugin-made branch only when its tip is the accepted commit, that commit is already in the target,
     * and no worktree has it checked out. The ref is removed with a compare-and-delete on that exact commit.
     */
    async deleteMergedBranch(input) {
      if (!input.branch.startsWith('paseo-todo/') || !branchSchema.safeParse(input.branch).success) {
        throw new Error(`只删除插件创建的 paseo-todo/ 任务分支：${input.branch}`);
      }
      if (!await this.branchExists(input.root, input.branch)) return;
      const ref = `refs/heads/${input.branch}`;
      const head = await rev(input.root, ref);
      if (head !== input.expectedHead) throw new Error('任务分支在验收之后已变化，没有删除');
      if ((await worktrees(input.root)).some(row => row.branch === ref)) throw new Error('任务分支仍在某个工作树检出，没有删除');
      const merged = await text(input.root, ['merge-base', '--is-ancestor', input.expectedHead, `refs/heads/${input.targetBranch}`]);
      if (merged.code === 1) throw new Error(`任务分支尚未合并进 ${input.targetBranch}，没有删除`);
      if (merged.code !== 0) throw new Error(clip(merged.stderr || '无法确认任务分支是否已合并'));
      const deleted = await text(input.root, ['update-ref', '-d', ref, input.expectedHead]);
      if (deleted.code !== 0) throw new Error(clip(deleted.stderr || deleted.stdout || '无法删除任务分支'));
    },
    async applyMerge(input) {
      const ready = await preflight(input);
      if ('ok' in ready) return ready;
      if (ready.checkout) {
        const merged = await text(ready.checkout, ['merge', '--ff-only', '--no-edit', input.mergeCommit]);
        if (merged.code !== 0) return { ok: false, reason: 'verify-failed', detail: clip(merged.stderr || merged.stdout || 'ff-only 合并失败') };
        const head = await rev(ready.checkout, 'HEAD');
        const ref = await rev(input.root, `refs/heads/${input.targetBranch}`);
        if (head !== input.mergeCommit || ref !== input.mergeCommit) {
          return { ok: false, reason: 'verify-failed', detail: 'ff-only 之后目标 HEAD 与预计算提交不一致' };
        }
        return { ok: true, mergeCommit: input.mergeCommit, method: 'ff-only' };
      }
      const updated = await text(input.root, ['update-ref', `refs/heads/${input.targetBranch}`, input.mergeCommit, input.expectedTargetHead]);
      if (updated.code !== 0) return { ok: false, reason: 'stale-target', detail: clip(updated.stderr || updated.stdout || '目标引用比较并交换失败') };
      const ref = await rev(input.root, `refs/heads/${input.targetBranch}`);
      if (ref !== input.mergeCommit) return { ok: false, reason: 'verify-failed', detail: 'update-ref 之后目标分支与预计算提交不一致' };
      return { ok: true, mergeCommit: input.mergeCommit, method: 'update-ref' };
    },
  };
}
