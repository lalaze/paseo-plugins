import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSchema, type Run, type Operation, type Profile, type Evidence, type Plan } from "../shared/schema";
import { Engine, type AgentGateway, type AgentSnapshot } from "../server/engine";
import { Store } from "../server/store";
import type { Repository } from "../server/repository";

export const settings = () => SettingsSchema.parse({ profiles: [{ id: "lead", label: "总 AI", provider: "vendor-a/model-a" }, { id: "worker", label: "执行 AI", provider: "vendor-b/model-b" }], directorProfileId: "lead", workerProfileId: "worker", verificationCommands: [{ label: "test", command: "npm", args: ["test"] }] });
export const reviewerSettings = () => SettingsSchema.parse({ ...settings(), profiles: [...settings().profiles, { id: "audit", label: "审核 AI", provider: "vendor-c/model-c", modeId: "auto-review", thinkingOptionId: "high", transport: "mcp" }], reviewerProfileId: "audit" });
export const plan: Plan = { summary: "实现功能", architecture: "模块接口", acceptance: ["完整功能可用"], tasks: [{ id: "task-1", title: "实现", description: "实现接口", category: "backend", dependsOn: [], files: ["src/**"], acceptance: ["接口测试通过"] }] };
export const result = { status: "ready_for_review", summary: "实现完毕", tests: ["npm test"], issues: [] };
export const review = (final = false, decision = "approved") => ({ decision, artifactId: "artifact-v1", summary: "审核结论", criteria: (final ? ["完整功能可用", "接口测试通过"] : ["接口测试通过"]).map(criterion => ({ criterion, passed: decision === "approved", evidence: "代码和测试记录" })), findings: decision === "changes_requested" ? [{ taskId: "task-1", location: "src/api.ts:10", problem: "遗漏空值", change: "增加空值处理", verification: "增加空值用例" }] : [] });

export class FakeAgents implements AgentGateway {
  directory = "/repo";
  async workspaceDirectory(_workspaceId: string) { return this.directory; }
  async retainWorkspaceName(_workspaceId: string) {}
  created: { id: string; runId: string; opId: string; profile: Profile }[] = [];
  sent: { agentId: string; opId: string; prompt: string }[] = [];
  states = new Map<string, AgentSnapshot>();
  stopped: string[] = [];
  async create(run: Run, op: Operation, profile: Profile) {
    const id = `agent-${this.created.length + 1}`;
    this.created.push({ id, runId: run.id, opId: op.id, profile }); this.states.set(id, { status: "idle", seen: false, output: "" }); return id;
  }
  async find(runId: string, operationId: string) { return this.created.filter(a => a.runId === runId && a.opId === operationId).map(a => a.id); }
  async inspect(agentId: string) { return this.states.get(agentId) ?? { status: "missing" as const, seen: false, output: "" }; }
  async send(agentId: string, opId: string, prompt: string) { this.sent.push({ agentId, opId, prompt }); this.states.set(agentId, { status: "running", seen: true, output: "" }); }
  async stop(agentId: string) { this.stopped.push(agentId); this.states.set(agentId, { status: "idle", seen: true, output: "" }); }
}
export class FakeRepository implements Repository {
  async assertBranch(_run: Run) {}
  version = "artifact-v1";
  passed = true;
  verifications = 0;
  discarded: Evidence[] = [];
  async fingerprint() { return this.version; }
  async discard(evidence: Evidence) { this.discarded.push(evidence); }
  async prepare(repository: string, runId: string, currentWorkspace = false) { return { repository, cwd: currentWorkspace ? repository : `/worktrees/${runId}`, baseCommit: "base", branch: `director/${runId}` }; }
  async capture() { return { id: this.version, tree: "tree", diffPath: "/artifacts/code.patch", changedFiles: ["src/api.ts"], diff: "diff", capturedAt: 1 }; }
  async verify(run: Run): Promise<Evidence> {
    this.verifications++;
    if (!run.settings.verificationCommands.length) return { ...await this.capture(), checks: [], passed: false, verificationStatus: "not_configured" };
    return { ...await this.capture(), checks: [{ label: "test", exitCode: this.passed ? 0 : 1, output: "test log", logPath: "/artifacts/test.log" }], passed: this.passed };
  }
}
export async function harness(overrides = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "director-engine-")));
  let store = new Store(join(directory, "db.sqlite"));
  const agents = new FakeAgents(), repository = new FakeRepository();
  let now = Date.now(), engine = new Engine(store, agents, repository, () => now);
  const id = await engine.create({ requestId: "request-1", repository: "/repo", goal: "实现新功能", settings: SettingsSchema.parse({ ...settings(), ...overrides }) });
  return {
    id, directory, agents, repository,
    get engine() { return engine; }, get store() { return store; },
    run: () => store.get(id), op: () => { const run = store.get(id); return run.operations.find(o => o.id === run.activeOperationId); },
    elapse(ms: number) { now += ms; },
    async until(kind: Operation["kind"]) {
      for (let i = 0; i < 40; i++) {
        const run = store.get(id), op = run.operations.find(o => o.id === run.activeOperationId);
        if (op?.kind === kind && op.state === "sent") return op;
        await engine.tick();
      }
      const run = store.get(id);
      throw new Error(`没有到达 ${kind}: ${run.phase}/${run.control}: ${run.message}`);
    },
    async complete(payload: unknown) {
      const run = store.get(id), op = run.operations.find(o => o.id === run.activeOperationId)!;
      agents.states.set(op.agentId!, { status: "idle", seen: true, output: JSON.stringify(payload) }); await engine.tick();
    },
    async restart() { await engine.close(); store.close(); store = new Store(join(directory, "db.sqlite")); engine = new Engine(store, agents, repository, () => now); },
    async cleanup() { await engine.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
