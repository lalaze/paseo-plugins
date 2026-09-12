import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Run, Evidence, Command } from "../shared/schema";

const exec = promisify(execFile);
export interface Repository {
  prepare(repository: string, runId: string, currentWorkspace?: boolean): Promise<{ repository: string; cwd: string; baseCommit: string; branch: string }>;
  assertBranch(run: Run): Promise<void>;
  capture(run: Run): Promise<Omit<Evidence, "checks" | "passed">>;
  verify(run: Run, signal: AbortSignal): Promise<Evidence>;
}
export class GitRepository implements Repository {
  constructor(private root: string) {}
  private async gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return (await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout;
  }
  private async git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return (await this.gitOutput(cwd, args, env)).trimEnd();
  }
  async prepare(repository: string, runId: string, currentWorkspace = false) {
    if (!isAbsolute(repository)) throw new Error("仓库路径必须是绝对路径");
    const repositoryRoot = await realpath(await this.git(await realpath(repository), ["rev-parse", "--show-toplevel"]));
    if (currentWorkspace && await realpath(repository) !== repositoryRoot) throw new Error("请在项目根目录的工作区启动，或选择独立工作区执行");
    if ((await this.git(repositoryRoot, ["status", "--porcelain"])).trim()) throw new Error("请先提交或用 Git stash 保存仓库中的未提交改动；Director 从当前提交创建成果分支");
    const baseCommit = await this.git(repositoryRoot, ["rev-parse", "HEAD"]);
    const cwd = join(this.root, "worktrees", runId), branch = `director/${runId}`;
    if (currentWorkspace) {
      const currentBranch = await this.git(repositoryRoot, ["branch", "--show-current"]);
      if (currentBranch !== branch) await this.git(repositoryRoot, ["switch", "-c", branch]);
      return { repository: repositoryRoot, cwd: repositoryRoot, baseCommit, branch };
    }
    await mkdir(join(this.root, "worktrees"), { recursive: true, mode: 0o700 });
    // A request id deterministically names its worktree; recover preparation after a crash.
    try {
      const existingBase = await this.git(cwd, ["rev-parse", "HEAD"]);
      const existingBranch = await this.git(cwd, ["branch", "--show-current"]);
      if (existingBranch !== branch) throw new Error("恢复工作区的分支不匹配");
      return { repository: repositoryRoot, cwd, baseCommit: existingBase, branch };
    } catch (e) {
      if (!(e as NodeJS.ErrnoException).code || (e as Error).message.includes("分支不匹配")) throw e;
    }
    await this.git(repositoryRoot, ["worktree", "add", "-b", branch, cwd, baseCommit]);
    return { repository: repositoryRoot, cwd, baseCommit, branch };
  }
  async assertBranch(run: Run) {
    if (run.workspaceId && await this.git(run.cwd, ["branch", "--show-current"]) !== run.branch) throw new Error(`工作区已切换分支，请切回 ${run.branch} 后重试`);
  }
  async capture(run: Run) {
    await this.assertBranch(run);
    const directory = join(this.root, "artifacts", run.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(directory, "index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await this.git(run.cwd, ["read-tree", "HEAD"], env);
      await this.git(run.cwd, ["add", "-A", "--", "."], env);
      const tree = await this.git(run.cwd, ["write-tree"], env);
      const id = createHash("sha256").update(run.baseCommit + ":" + tree).digest("hex");
      // Patches and NUL-delimited paths must retain their exact whitespace.
      const diff = await this.gitOutput(run.cwd, ["diff", "--binary", run.baseCommit, tree, "--"]);
      const names = await this.gitOutput(run.cwd, ["diff", "--name-only", "-z", run.baseCommit, tree, "--"]);
      const diffPath = join(directory, `${id}.patch`);
      await writeFile(diffPath, diff, { mode: 0o600 });
      // Keep the tree reachable even if Git prunes loose objects later.
      await this.git(run.cwd, ["update-ref", `refs/paseo-director/${run.id}/${id}`, tree]);
      return { id, tree, diffPath, changedFiles: names.split("\0").filter(Boolean), diff: diff.slice(0, 48000), capturedAt: Date.now() };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async verify(run: Run, signal: AbortSignal): Promise<Evidence> {
    if (signal.aborted) throw new Error("验证已中止");
    const snapshot = await this.capture(run);
    if (!run.settings.verificationCommands.length) {
      return { ...snapshot, checks: [], passed: false, verificationStatus: "not_configured" };
    }
    const checks: Evidence["checks"] = [];
    for (const command of run.settings.verificationCommands) {
      if (signal.aborted) throw new Error("验证已中止");
      const result = await executeCheck(command, run.cwd, signal);
      const logPath = join(this.root, "artifacts", run.id, `${randomUUID()}.log`);
      await writeFile(logPath, result.output, { mode: 0o600 });
      checks.push({ label: command.label, exitCode: result.exitCode, logPath, output: result.output.slice(-6000) });
    }
    const after = await this.capture(run);
    if (after.id !== snapshot.id) throw new Error("验收命令改变了源文件，请使用不修改源文件的验证命令后重试");
    const passed = checks.every(c => c.exitCode === 0);
    return { ...snapshot, checks, passed, verificationStatus: passed ? "passed" : "failed" };
  }
}

export function executeCheck(command: Command, cwd: string, signal: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  return new Promise(resolve => {
    let output = "", finished = false, timedOut = false;
    const child = spawn(command.command, command.args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const append = (data: Buffer | string) => { if (output.length < 262144) output += data.toString().slice(0, 262144 - output.length); };
    const stop = () => {
      if (!child.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const finish = (exitCode: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (timedOut) output += "\n[Director: 验证超时]";
      if (signal.aborted) output += "\n[Director: 验证取消]";
      resolve({ exitCode: timedOut || signal.aborted ? null : exitCode, output });
    };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", error => { append(error.message); finish(null); });
    child.on("close", finish);
  });
}
