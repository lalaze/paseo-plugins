import { z } from "zod";

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const Text = z.string().trim().min(1).max(16000);
export const InstructionTextSchema = z.string().max(8000);
export const RolePromptsSchema = z.object({
  plan: InstructionTextSchema.optional(), execute: InstructionTextSchema.optional(), review: InstructionTextSchema.optional(),
});
export type RolePrompts = z.infer<typeof RolePromptsSchema>;
export const ProfileSchema = z.object({
  id: Id, label: z.string().min(1).max(120),
  provider: z.string().regex(/^[^/\s]+\/.+$/, "请选择供应商和模型"),
  modeId: z.string().optional(), thinkingOptionId: z.string().optional(),
  transport: z.enum(["structured", "mcp"]).default("structured"),
  instructions: InstructionTextSchema.optional(),
});
export const CommandSchema = z.object({
  label: z.string().min(1).max(120), command: z.string().min(1).max(1000),
  args: z.array(z.string()).max(80).default([]), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
});
export const SettingsSchema = z.object({
  profiles: z.array(ProfileSchema).min(1).max(30), directorProfileId: Id, workerProfileId: Id,
  /** Omitted means review in the original design session, preserving old settings. */
  reviewerProfileId: Id.optional(),
  rolePrompts: RolePromptsSchema.optional(),
  categoryOverrides: z.record(z.string(), Id).default({}), taskOverrides: z.record(z.string(), Id).default({}),
  allowDirectorSelection: z.boolean().default(false),
  maxReworks: z.number().int().min(0).max(10).default(2),
  maxAttempts: z.number().int().min(3).max(200).default(40),
  turnTimeoutMs: z.number().int().min(1000).max(7200000).default(1800000),
  runTimeoutMs: z.number().int().min(1000).max(86400000).default(14400000),
  requirePlanApproval: z.boolean().default(false),
  verificationCommands: z.array(CommandSchema).max(12).default([]),
}).superRefine((s, ctx) => {
  const ids = new Set(s.profiles.map(p => p.id));
  if (ids.size !== s.profiles.length) ctx.addIssue({ code: "custom", message: "AI 配置 ID 不能重复" });
  for (const id of [s.directorProfileId, s.workerProfileId, ...(s.reviewerProfileId ? [s.reviewerProfileId] : []), ...Object.values(s.categoryOverrides), ...Object.values(s.taskOverrides)]) {
    if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `不存在的 AI 配置：${id}` });
  }
});
export const TaskSchema = z.object({
  id: Id, title: Text, description: Text, category: z.string().min(1).max(80),
  dependsOn: z.array(Id).max(30), files: z.array(z.string().min(1).max(1000)).min(1).max(100),
  acceptance: z.array(Text).min(1).max(30), executorId: Id.optional(),
});
export const PlanSchema = z.object({
  summary: Text, architecture: Text, acceptance: z.array(Text).min(1).max(30),
  tasks: z.array(TaskSchema).min(1).max(30),
});
export const ResultSchema = z.object({
  status: z.enum(["ready_for_review", "blocked"]), summary: Text,
  tests: z.array(Text).max(30), issues: z.array(Text).max(30),
});
export const ReviewSchema = z.object({
  decision: z.enum(["approved", "changes_requested", "blocked"]),
  artifactId: z.string().min(1), summary: Text,
  criteria: z.array(z.object({ criterion: Text, passed: z.boolean(), evidence: Text })).min(1).max(60),
  findings: z.array(z.object({ taskId: Id, location: Text, problem: Text, change: Text, verification: Text })).max(60),
}).superRefine((r, ctx) => {
  if (r.decision === "approved" && (r.findings.length || r.criteria.some(c => !c.passed))) {
    ctx.addIssue({ code: "custom", message: "存在未通过项或修改要求时不能批准" });
  }
  if (r.decision === "changes_requested" && !r.findings.length) ctx.addIssue({ code: "custom", message: "返工必须提供具体修改要求" });
});
export type Profile = z.infer<typeof ProfileSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Command = z.infer<typeof CommandSchema>;

export type Evidence = {
  id: string; tree: string; diffPath: string; changedFiles: string[]; diff: string;
  checks: { label: string; exitCode: number | null; logPath: string; output: string }[];
  passed: boolean; capturedAt: number;
  verificationStatus?: "not_configured" | "passed" | "failed";
};
export type Operation = {
  id: string; kind: "plan" | "execute" | "review" | "final";
  taskId?: string; profileId: string; agentId?: string;
  state: "pending" | "creating" | "ready" | "sending" | "sent" | "done" | "abandoned";
  prompt: string; createdAt: number; sentAt?: number; deliveryConfirmedAt?: number; completedAt?: number; observedBusy?: boolean;
  response?: unknown; responseHash?: string; formatRetries: number;
};
export type AgentRole = "director" | "worker" | "reviewer";
// Task IDs cannot contain ':', so this actor cannot collide with a legacy task.
export const REVIEWER_ACTOR = "role:reviewer";
export function operationRole(settings: Settings, kind: Operation["kind"]): AgentRole {
  return kind === "execute" ? "worker" : kind === "plan" || !settings.reviewerProfileId ? "director" : "reviewer";
}
export function operationLabel(settings: Settings, kind: Operation["kind"]): string {
  const role = operationRole(settings, kind);
  return role === "worker" ? "执行 AI" : role === "reviewer" ? "审核 AI" : settings.reviewerProfileId ? "设计 AI" : "总 AI";
}
export type UserAcceptance = { decision: "approved" | "rejected"; artifactId: string; decidedAt: number };
export type ChangeRequest = {
  requestedAt: number; feedback: string; planVersion: number; artifactId: string;
  previousPlan: Plan; previousReview: Review; previousAcceptance?: UserAcceptance;
  previousTasks: { id: string; profileId: string; agentId?: string; result?: Result }[];
};
export type FinalControl = { feedback?: string; artifactId?: string; expectedRevision?: number };
export type ControlAction = "pause" | "resume" | "cancel" | "retry" | "approve_plan" | "revise" | "accept_final" | "reject_final" | "request_changes";
export type Run = {
  id: string; requestId: string; revision: number; goal: string; repository: string;
  cwd: string; baseCommit: string; branch: string; settings: Settings;
  /** Absent on legacy runs, which use an isolated worktree. */
  workspaceId?: string;
  createdAt: number; updatedAt: number; directorAgentId?: string; reviewerAgentId?: string;
  phase: "planning" | "executing" | "reviewing" | "final_review" | "awaiting_acceptance" | "completed";
  control: "running" | "paused" | "waiting_permission" | "needs_attention" | "canceling" | "canceled";
  message: string; plan?: Plan; planApproved: boolean; planApprovedAt?: number;
  stopTarget?: "canceled" | "needs_attention";
  planVersion?: number; dispatchOrder?: string[];
  userAcceptance?: UserAcceptance; changeRequests?: ChangeRequest[];
  /** Explicit user-requested rounds get their own bounded execution budget. */
  roundStartedAt?: number; roundOperationOffset?: number;
  tasks: { spec: Task; profileId: string; status: "pending" | "executing" | "reviewing" | "approved"; reworks: number; agentId?: string; feedback?: string; result?: Result; evidence?: Evidence; review?: Review }[];
  operations: Operation[]; activeOperationId?: string; finalEvidence?: Evidence; finalReview?: Review;
  events: { time: number; message: string }[];
};
/** Legacy completed runs can still be accepted or revised by their user. */
export function hasFinalResult(run: Run): boolean {
  return ["awaiting_acceptance", "completed"].includes(run.phase) && ["paused", "running"].includes(run.control)
    && run.finalReview?.decision === "approved" && !!run.finalEvidence && !run.activeOperationId;
}
export function awaitingAcceptance(run: Run): boolean { return hasFinalResult(run) && !run.userAcceptance; }
/** Planning can resume before a plan exists; a saved plan still needs approval. */
export function canResumeRun(run: Run): boolean {
  return !["completed", "awaiting_acceptance"].includes(run.phase)
    && ["paused", "waiting_permission"].includes(run.control) && (!run.plan || run.planApproved);
}
export type RunSummary = Pick<Run, "id" | "goal" | "cwd" | "phase" | "control" | "message" | "createdAt" | "updatedAt"> & { done: number; total: number };
export function summarize(run: Run): RunSummary {
  const { id, goal, cwd, phase, control, message, createdAt, updatedAt } = run;
  const waiting = awaitingAcceptance(run);
  return { id, goal, cwd, phase: waiting ? "awaiting_acceptance" : phase, control: waiting ? "paused" : control, message: waiting ? `${operationLabel(run.settings, "final")}最终审核通过，等待你验收或提出修改意见` : message, createdAt, updatedAt, done: run.tasks.filter(t => t.status === "approved").length, total: run.tasks.length };
}
export function profileForTask(settings: Settings, task: Task): string {
  return settings.taskOverrides[task.id] ?? settings.categoryOverrides[task.category]
    ?? (settings.allowDirectorSelection ? task.executorId : undefined) ?? settings.workerProfileId;
}
export function validatePlan(plan: Plan, settings: Settings): void {
  const map = new Map(plan.tasks.map(t => [t.id, t]));
  if (map.size !== plan.tasks.length) throw new Error("任务 ID 重复");
  const visited = new Set<string>(), active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error("任务依赖存在循环");
    if (visited.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error(`不存在的前置任务：${id}`);
    active.add(id); task.dependsOn.forEach(visit); active.delete(id); visited.add(id);
  }
  for (const task of plan.tasks) {
    if (task.id === "director") throw new Error("director 是保留角色 ID，不能作为任务 ID");
    visit(task.id);
    if (!settings.profiles.some(p => p.id === profileForTask(settings, task))) throw new Error(`任务 ${task.id} 指定了未知 AI`);
    if (task.files.some(f => f.startsWith("/") || f.split(/[\\/]/).includes(".."))) throw new Error("修改范围必须是工作区内的相对路径");
  }
}
export function parseOutput(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* Providers may wrap their final JSON in a fenced block. */ }
  const blocks = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (blocks.length) {
    const last = blocks.at(-1)!;
    if (!trimmed.slice(last.index! + last[0].length).trim()) return JSON.parse(last[1]);
  }
  // Earlier progress messages may precede a plain final JSON response. Only
  // accept a complete top-level object at the end, never a nested fragment.
  let depth = 0, inString = false, escaped = false, start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (depth === 0) { if (ch === "{") { start = i; depth = 1; inString = false; } continue; }
    if (escaped) { escaped = false; continue; }
    if (inString && ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0 && !trimmed.slice(i + 1).trim()) return JSON.parse(trimmed.slice(start, i + 1));
  }
  throw new Error("请通过指定工具提交结果，或只输出一个 JSON 对象");
}
