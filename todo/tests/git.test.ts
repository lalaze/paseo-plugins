import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { createGit, defaultGitRun, type GitRun } from '../server/git';
import { todoError } from '../shared/errors';

const exec = promisify(execFile);

function spy(): { run: GitRun; log: string[] } {
  const log: string[] = [];
  return {
    log,
    run: async (cwd, args, env) => {
      log.push(args.join(' '));
      return defaultGitRun(cwd, args, env);
    },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, encoding: 'utf8' });
  return String(result.stdout ?? '').trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'todo-git-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await writeFile(join(dir, 'note.txt'), 'base\n');
  await git(dir, ['add', 'note.txt']);
  await git(dir, ['commit', '-m', 'base']);
  return dir;
}

// Task worktrees live outside the repository, as they do under the data dir; inside it they would dirty the target checkout.
const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));
async function worktreeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'todo-wt-'));
  scratch.push(dir);
  return join(dir, 'worktrees');
}

function assertSafe(log: string[]) {
  for (const line of log) {
    assert.equal(/\bpush\b/.test(line), false, line);
    assert.equal(/\breset\b/.test(line), false, line);
    assert.equal(/\bclean\b/.test(line), false, line);
    assert.equal(/merge --abort/.test(line), false, line);
  }
}

describe('git merge and capture', () => {
  it('fast-forwards a checked-out clean target and update-refs a branch that is not checked out', async () => {
    const root = await initRepo();
    const detached = await initRepo();
    try {
      const watched = spy();
      const tool = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const base = await git(root, ['rev-parse', 'HEAD']);
      const ensured = await tool.ensureWorktree({
        root, taskId: '11111111-1111-4111-8111-111111111111', branch: 'paseo-todo/one', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'note.txt'), 'task\n');
      const captured = await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'capture' });
      const snap = await tool.snapshot({ root, worktree: ensured.worktree, branch: ensured.branch, targetBranch: 'main' });
      const prepared = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: base, resultCommit: captured.commit, resultTree: captured.tree,
        message: 'paseo-todo: accept',
      });
      assert.equal(prepared.ok, true);
      if (!prepared.ok) return;
      const applied = await tool.applyMerge(prepared);
      assert.deepEqual(applied, { ok: true, mergeCommit: prepared.mergeCommit, method: 'ff-only' });
      assert.equal(await git(root, ['rev-parse', 'HEAD']), prepared.mergeCommit);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'task\n');

      await git(detached, ['checkout', '--detach']);
      const other = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const otherBase = await git(detached, ['rev-parse', 'refs/heads/main']);
      const otherTree = await other.ensureWorktree({
        root: detached, taskId: '22222222-2222-4222-8222-222222222222', branch: 'paseo-todo/two', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(otherTree.worktree, 'note.txt'), 'side\n');
      const otherCaptured = await other.capture({ root: detached, worktree: otherTree.worktree, branch: otherTree.branch, message: 'capture' });
      const otherPrepared = await other.prepareMerge({
        root: detached, worktree: otherTree.worktree, taskBranch: otherTree.branch, targetBranch: 'main',
        expectedTargetHead: otherBase, resultCommit: otherCaptured.commit, resultTree: otherCaptured.tree,
        message: 'paseo-todo: accept',
      });
      assert.equal(otherPrepared.ok, true);
      if (!otherPrepared.ok) return;
      const otherApplied = await other.applyMerge(otherPrepared);
      assert.deepEqual(otherApplied, { ok: true, mergeCommit: otherPrepared.mergeCommit, method: 'update-ref' });
      assert.equal(await git(detached, ['rev-parse', 'refs/heads/main']), otherPrepared.mergeCommit);
      assert.equal(await git(detached, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
      assertSafe(watched.log);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(detached, { recursive: true, force: true });
    }
  });

  it('refuses a dirty target, a conflict, a stale binding, and an in-progress merge without aborting', async () => {
    const root = await initRepo();
    try {
      const watched = spy();
      const tool = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const base = await git(root, ['rev-parse', 'HEAD']);
      const ensured = await tool.ensureWorktree({
        root, taskId: '33333333-3333-4333-8333-333333333333', branch: 'paseo-todo/three', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'note.txt'), 'task\n');
      const captured = await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'capture' });
      await writeFile(join(root, 'note.txt'), 'dirty\n');
      const dirty = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: base, resultCommit: captured.commit, resultTree: captured.tree, message: 'merge',
      });
      assert.equal(dirty.ok, false);
      if (!dirty.ok) assert.equal(dirty.reason, 'dirty');
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'dirty\n');
      assert.equal(await git(root, ['rev-parse', 'refs/heads/main']), base);
      await git(root, ['checkout', '--', 'note.txt']);

      await writeFile(join(root, 'note.txt'), 'main changed\n');
      await git(root, ['add', 'note.txt']);
      await git(root, ['commit', '-m', 'move']);
      const moved = await git(root, ['rev-parse', 'HEAD']);
      const stale = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: base, resultCommit: captured.commit, resultTree: captured.tree, message: 'merge',
      });
      assert.equal(stale.ok, false);
      if (!stale.ok) assert.equal(stale.reason, 'stale-target');
      assert.equal(await git(root, ['rev-parse', 'refs/heads/main']), moved);

      await git(root, ['reset', '--hard', base]);
      await writeFile(join(ensured.worktree, 'note.txt'), 'other\n');
      const conflictBranch = await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'conflict' });
      await writeFile(join(root, 'note.txt'), 'main side\n');
      await git(root, ['add', 'note.txt']);
      await git(root, ['commit', '-m', 'conflict']);
      const conflictHead = await git(root, ['rev-parse', 'HEAD']);
      const beforeTask = await git(root, ['rev-parse', 'refs/heads/paseo-todo/three']);
      const conflict = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: conflictHead, resultCommit: conflictBranch.commit, resultTree: conflictBranch.tree, message: 'merge',
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.reason, 'conflict');
      assert.equal(await git(root, ['rev-parse', 'refs/heads/main']), conflictHead);
      assert.equal(await git(root, ['rev-parse', 'refs/heads/paseo-todo/three']), beforeTask);
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'main side\n');

      const badTree = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: conflictHead, resultCommit: conflictBranch.commit, resultTree: 'ab'.repeat(20), message: 'merge',
      });
      assert.equal(badTree.ok, false);
      if (!badTree.ok) assert.equal(badTree.reason, 'stale-result');

      const marker = (await git(root, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim();
      const markerPath = marker.startsWith('/') ? marker : join(root, marker);
      await writeFile(markerPath, `${base}\n`);
      const busy = await tool.prepareMerge({
        root, worktree: ensured.worktree, taskBranch: ensured.branch, targetBranch: 'main',
        expectedTargetHead: conflictHead, resultCommit: conflictBranch.commit, resultTree: conflictBranch.tree, message: 'merge',
      });
      assert.equal(busy.ok, false);
      assert.equal(await readFile(markerPath, 'utf8'), `${base}\n`);
      assertSafe(watched.log);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not commit when the task directory left its branch or repository', async () => {
    const root = await initRepo();
    const other = await initRepo();
    try {
      const watched = spy();
      const tool = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const ensured = await tool.ensureWorktree({
        root, taskId: '44444444-4444-4444-8444-444444444444', branch: 'paseo-todo/four', targetBranch: 'main', existingPath: null,
      });
      await git(ensured.worktree, ['switch', '-c', 'side']);
      const side = await git(ensured.worktree, ['rev-parse', 'HEAD']);
      await writeFile(join(ensured.worktree, 'note.txt'), 'wrong branch\n');
      await assert.rejects(
        () => tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'nope' }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === todoError('worktree-moved').code,
      );
      assert.equal(await git(ensured.worktree, ['rev-parse', 'refs/heads/side']), side);
      await assert.rejects(
        () => tool.capture({ root, worktree: other, branch: ensured.branch, message: 'nope' }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'worktree-moved',
      );
      await assert.rejects(
        () => tool.snapshot({ root, worktree: other, branch: ensured.branch, targetBranch: 'main' }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'worktree-moved',
      );
      assertSafe(watched.log);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it('reviews only the task\'s own changes when the target moved on after the task branched', async () => {
    const root = await initRepo();
    try {
      const tool = createGit({ worktreeRoot: await worktreeRoot() });
      const ensured = await tool.ensureWorktree({
        root, taskId: '55555555-5555-4555-8555-555555555555', branch: 'paseo-todo/five', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'task.txt'), 'task\n');
      const captured = await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'capture' });
      await writeFile(join(root, 'main-only.txt'), 'landed on main meanwhile\n');
      await git(root, ['add', 'main-only.txt']);
      await git(root, ['commit', '-m', 'main moved']);
      const targetHead = await git(root, ['rev-parse', 'HEAD']);
      const diff = await tool.diff({ root, worktree: ensured.worktree, branch: ensured.branch, from: targetHead, to: captured.commit });
      assert.deepEqual(diff.files, ['task.txt']);
      assert.doesNotMatch(diff.patch, /main-only/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes a merged task worktree and deletes its branch, and refuses anything else', async () => {
    const root = await initRepo();
    try {
      const watched = spy();
      const tool = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const base = await git(root, ['rev-parse', 'HEAD']);
      const ensured = await tool.ensureWorktree({
        root, taskId: '66666666-6666-4666-8666-666666666666', branch: 'paseo-todo/six', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'note.txt'), 'six\n');
      const captured = await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'capture' });
      const target = { root, branch: ensured.branch, expectedHead: captured.commit, targetBranch: 'main' };

      // Not merged yet: the branch stays.
      await tool.removeWorktree({ root, worktree: ensured.worktree, branch: ensured.branch });
      await assert.rejects(tool.deleteMergedBranch(target), /尚未合并/);
      assert.equal(await git(root, ['rev-parse', 'refs/heads/paseo-todo/six']), captured.commit);

      await git(root, ['merge', '--ff-only', captured.commit]);

      await assert.rejects(tool.deleteMergedBranch({ ...target, branch: 'main' }), /paseo-todo\//);
      await assert.rejects(tool.deleteMergedBranch({ ...target, expectedHead: base }), /已变化/);
      await tool.deleteMergedBranch(target);
      assert.equal((await exec('git', ['branch', '--list', 'paseo-todo/six'], { cwd: root })).stdout.trim(), '');
      // Idempotent once gone.
      await tool.deleteMergedBranch(target);
      await tool.removeWorktree({ root, worktree: ensured.worktree, branch: ensured.branch });
      assert.doesNotMatch(await git(root, ['worktree', 'list']), /six/);
      assertSafe(watched.log);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a worktree with uncommitted work and a branch another worktree still has checked out', async () => {
    const root = await initRepo();
    try {
      const tool = createGit({ worktreeRoot: await worktreeRoot() });
      const ensured = await tool.ensureWorktree({
        root, taskId: '77777777-7777-4777-8777-777777777777', branch: 'paseo-todo/seven', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'stray.txt'), 'not committed\n');
      await assert.rejects(tool.removeWorktree({ root, worktree: ensured.worktree, branch: ensured.branch }));
      assert.equal(await readFile(join(ensured.worktree, 'stray.txt'), 'utf8'), 'not committed\n');
      const head = await git(root, ['rev-parse', 'refs/heads/paseo-todo/seven']);
      await assert.rejects(tool.deleteMergedBranch({ root, branch: ensured.branch, expectedHead: head, targetBranch: 'main' }), /检出/);
      assert.equal(await git(root, ['rev-parse', 'refs/heads/paseo-todo/seven']), head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshots with a fixed small number of git processes', async () => {
    const root = await initRepo();
    try {
      const watched = spy();
      const tool = createGit({ run: watched.run, worktreeRoot: await worktreeRoot() });
      const ensured = await tool.ensureWorktree({
        root, taskId: '88888888-8888-4888-8888-888888888888', branch: 'paseo-todo/eight', targetBranch: 'main', existingPath: null,
      });
      await writeFile(join(ensured.worktree, 'note.txt'), 'eight\n');
      await tool.capture({ root, worktree: ensured.worktree, branch: ensured.branch, message: 'capture' });
      watched.log.length = 0;
      const snap = await tool.snapshot({ root, worktree: ensured.worktree, branch: ensured.branch, targetBranch: 'main' });
      assert.equal(snap.clean, true);
      // assertTaskCheckout (toplevel+common-dir, root common-dir, branch, operation markers) + HEAD/tree + status + target.
      assert.deepEqual(watched.log, [
        'rev-parse --show-toplevel --git-common-dir',
        'rev-parse --git-common-dir',
        'branch --show-current',
        'rev-parse --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD --git-path rebase-merge --git-path rebase-apply',
        'rev-parse HEAD HEAD^{tree}',
        'status --porcelain=v1 --untracked-files=all',
        'rev-parse refs/heads/main',
      ]);
      assertSafe(watched.log);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

