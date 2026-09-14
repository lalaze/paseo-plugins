import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitRepository, executeCheck } from "../server/repository";
import { settings } from "./helpers";
import type { Run } from "../shared/schema";
const exec = promisify(execFile);

test("current-workspace mode preserves dirty work and index, reviews existing changes, and refuses switched checkouts", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-current-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await writeFile(join(repo, "deleted.txt"), "delete me\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, "app.txt"), "staged\n");
  await exec("git", ["add", "app.txt"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "unsaved\n");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  await writeFile(join(repo, "ignored.txt"), "ignored\n");
  await rm(join(repo, "deleted.txt"));
  const status = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
  const staged = (await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout;
  const work = await repository.prepare(repo, "current", true);
  assert.equal(work.cwd, repo); assert.equal(work.branch, "director/current");
  assert.equal(work.baseCommit, baseCommit);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), baseCommit);
  assert.equal((await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(), work.branch);
  assert.equal((await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(/^worktree /gm)?.length, 1);
  assert.deepEqual(await repository.prepare(repo, "current", true), work);
  const run = { ...work, id: "current", workspaceId: "workspace", settings: settings() } as Run;
  const evidence = await repository.capture(run);
  assert.deepEqual(evidence.changedFiles, ["app.txt", "deleted.txt", "new.txt"]);
  assert.match(evidence.diff, /unsaved/); assert.match(evidence.diff, /untracked/);
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout, status);
  assert.equal((await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout, staged);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "unsaved\n");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await readFile(join(repo, "ignored.txt"), "utf8"), "ignored\n");
  await writeFile(join(repo, "app.txt"), "after\n");
  const updated = await repository.capture(run);
  assert.notEqual(updated.id, evidence.id);
  assert.match(updated.diff, /after/);
  assert.equal((await exec("git", ["diff", "--cached", "--binary"], { cwd: repo })).stdout, staged);
  assert.equal((await exec("git", ["show", "main:app.txt"], { cwd: repo })).stdout, "before\n");
  await exec("git", ["switch", "main"], { cwd: repo });
  await assert.rejects(repository.capture(run), /切回 director\/current/);
});

test("isolated mode directs dirty repositories to current-workspace mode without changing user work", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-isolated-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  await writeFile(join(repo, "new.txt"), "untracked\n");
  await assert.rejects(repository.prepare(repo, "isolated"), /在当前工作区执行/);
  assert.equal((await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(), "main");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "untracked\n");
  assert.equal((await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout.match(/^worktree /gm)?.length, 1);
});

test("current-workspace mode refuses unresolved conflicts without switching branches", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-conflict-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "base\n");
  await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  await exec("git", ["switch", "-c", "other"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "other\n"); await exec("git", ["commit", "-am", "other"], { cwd: repo });
  await exec("git", ["switch", "main"], { cwd: repo });
  await writeFile(join(repo, "app.txt"), "main\n"); await exec("git", ["commit", "-am", "main"], { cwd: repo });
  await assert.rejects(exec("git", ["merge", "other"], { cwd: repo }));
  const status = (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout;
  await assert.rejects(new GitRepository(join(root, "state")).prepare(repo, "conflict", true), /未解决的合并冲突/);
  assert.equal((await exec("git", ["branch", "--show-current"], { cwd: repo })).stdout.trim(), "main");
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout, status);
});

test("worktree and immutable snapshot include untracked source, preserve user's index, and catch failing checks", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-git-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  for (const args of [["init"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const work = await repository.prepare(repo, "run-1");
  const run = { ...work, id: "run-1", settings: settings() } as Run;
  assert.notEqual(work.cwd, repo);
  await writeFile(join(work.cwd, "app.txt"), "after\n"); await writeFile(join(work.cwd, "new.txt"), "new file\n");
  const beforeIndex = (await exec("git", ["diff", "--cached"], { cwd: work.cwd })).stdout;
  const evidence = await repository.capture(run);
  assert.deepEqual(evidence.changedFiles.sort(), ["app.txt", "new.txt"]);
  assert.match(await readFile(evidence.diffPath, "utf8"), /new file/);
  assert.equal((await repository.capture(run)).id, evidence.id);
  assert.equal((await exec("git", ["diff", "--cached"], { cwd: work.cwd })).stdout, beforeIndex);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "before\n");
  run.settings.verificationCommands = [{ label: "pass", command: process.execPath, args: ["-e", "console.log('ok')"], timeoutMs: 1000 }];
  assert.equal((await repository.verify(run, new AbortController().signal)).passed, true);
  run.settings.verificationCommands[0].args = ["-e", "process.exit(1)"];
  assert.equal((await repository.verify(run, new AbortController().signal)).passed, false);
  run.settings.verificationCommands = [];
  const noChecks = await repository.verify(run, new AbortController().signal);
  assert.equal(noChecks.id, evidence.id);
  assert.equal(noChecks.verificationStatus, "not_configured");
  assert.equal(noChecks.passed, false);
  assert.deepEqual(noChecks.checks, []);
  assert.match(noChecks.diff, /new file/);
});

test("saved snapshot patches apply cleanly and preserve exact text and binary contents", async t => {
  const root = await mkdtemp(join(tmpdir(), "director-patch-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "app.txt"), "before\n");
  await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const repository = new GitRepository(join(root, "state"));
  const work = await repository.prepare(repo, "patch"), run = { ...work, id: "patch", settings: settings() } as Run;
  for (const content of ["after\n", "after  \t\n", "after without newline", Buffer.from([0, 1, 255, 10, 0, 32])]) {
    await writeFile(join(work.cwd, "app.txt"), content);
    const evidence = await repository.capture(run);
    const patch = await readFile(evidence.diffPath, "utf8");
    const rawDiff = (await exec("git", ["diff", "--binary", work.baseCommit, evidence.tree, "--"], { cwd: work.cwd })).stdout;
    assert.equal(patch, rawDiff); assert.equal(evidence.diff, rawDiff);
    await exec("git", ["apply", "--check", evidence.diffPath], { cwd: repo });
    await exec("git", ["apply", "--whitespace=nowarn", evidence.diffPath], { cwd: repo });
    assert.deepEqual(await readFile(join(repo, "app.txt")), Buffer.from(content));
    await exec("git", ["apply", "--reverse", "--whitespace=nowarn", evidence.diffPath], { cwd: repo });
  }
});

test("verification timeout and cancellation terminate the subprocess", async () => {
  const controller = new AbortController();
  const pending = executeCheck({ label: "cancel", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 5000 }, tmpdir(), controller.signal);
  controller.abort();
  const outcome = await pending; assert.equal(outcome.exitCode, null); assert.match(outcome.output, /取消/);
  const timeout = await executeCheck({ label: "timeout", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 20 }, tmpdir(), new AbortController().signal);
  assert.equal(timeout.exitCode, null); assert.match(timeout.output, /超时/);
});
