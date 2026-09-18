import { z } from "zod";
import { PlanSchema, ProfileSchema, TaskSchema } from "../shared/schema";
import { ui } from "./i18n";

export const PromptCardSchema = z.object({
  stage: z.enum(["plan", "execute", "review", "final"]),
  goal: z.string(), cwd: z.string(), branch: z.string().optional(),
  team: z.array(z.object({ role: z.string(), name: z.string() })),
  task: z.string().optional(), description: z.string().optional(),
  changes: z.array(z.string()).optional(),
  preInstructions: z.array(z.object({ source: z.string(), text: z.string() })).optional(),
  actor: z.string().optional(),
  acceptance: z.array(z.string()), files: z.array(z.string()), next: z.string(), raw: z.string(),
});
export type PromptCardData = z.infer<typeof PromptCardSchema>;
const ContextSchema = z.object({
  goal: z.string().min(1), cwd: z.string().min(1), branch: z.string().optional(),
  profiles: z.array(ProfileSchema).optional(),
  bindings: z.object({ director: z.string(), worker: z.string(), reviewer: z.string().optional() }).optional(),
  reviewer: z.object({ profileId: z.string(), separateSession: z.boolean() }).optional(),
  requirePlanApproval: z.boolean().optional(),
  acceptance: z.array(z.string()).optional(),
  userChangeRequests: z.array(z.object({ feedback: z.string() })).optional(),
  preInstructions: z.array(z.object({ source: z.string(), text: z.string() })).optional(),
  plan: PlanSchema.optional(), task: TaskSchema.optional(),
  dependencies: z.array(z.unknown()).optional(), taskResults: z.array(z.unknown()).optional(),
});

// Support already-sent prompts too. This changes display only; incomplete or
// unrecognized messages remain untouched, and the full original is retained.
export function readDirectorPrompt(raw: string): PromptCardData | undefined {
  const marker = /^\[paseo-director:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\]\n/i.exec(raw);
  if (!marker) return;
  const instructionEnd = raw.indexOf("\n\n", marker[0].length);
  const contextEnd = raw.indexOf(`\n\n本轮 operationId=${marker[1]}。`, instructionEnd);
  if (instructionEnd < 0 || contextEnd < 0) return;
  let context: z.infer<typeof ContextSchema>;
  try { context = ContextSchema.parse(JSON.parse(raw.slice(instructionEnd + 2, contextEnd))); } catch { return; }
  const instruction = raw.slice(marker[0].length, instructionEnd);
  let stage: PromptCardData["stage"];
  if ((instruction.startsWith("你是总 AI。") || instruction.startsWith("你是设计 AI。")) && context.profiles && context.bindings) stage = "plan";
  else if (instruction.startsWith("你是执行 AI。") && context.task && context.dependencies) stage = "execute";
  else if ((instruction.startsWith("你是原总 AI，") || instruction.startsWith("你是审核 AI，")) && context.plan) {
    if (context.taskResults) stage = "final";
    else if (context.task) stage = "review";
    else return;
  } else return;
  const tool = stage === "plan" ? "submit_plan" : stage === "execute" ? "submit_result" : "submit_review";
  if (!raw.slice(contextEnd).startsWith(`\n\n本轮 operationId=${marker[1]}。如果有 ${tool} 工具，`)) return;
  const team: PromptCardData["team"] = [];
  if (stage === "plan") {
    for (const [role, id] of [[context.bindings!.reviewer ? ui("Planning AI", "设计 AI") : ui("Lead AI · planning and review", "总 AI · 设计与审核"), context.bindings!.director], [ui("Default implementation AI", "默认执行 AI"), context.bindings!.worker], ...(context.bindings!.reviewer ? [[ui("Review AI · separate session", "审核 AI · 独立会话"), context.bindings!.reviewer]] : [])]) {
      const profile = context.profiles!.find(p => p.id === id);
      if (!profile) return;
      team.push({ role, name: `${profile.label} · ${profile.provider}` });
    }
  }
  const reviewer = context.reviewer?.separateSession ? ui("review AI", "审核 AI") : ui("lead AI", "总 AI");
  const next = stage === "plan"
    ? context.requirePlanApproval ? ui(`After the plan is ready, it waits for your approval. Tasks then run serially by dependency, followed by a final review from the ${reviewer}.`, `总纲完成后等你确认，再按依赖串行执行全部任务，完成后交给${reviewer}统一审核。`) : context.requirePlanApproval === false ? ui(`After the plan is ready, tasks run serially by dependency, followed by a final review from the ${reviewer}.`, `总纲完成后自动串行执行全部任务，再交给${reviewer}统一审核。`) : ui("After submission, implementation follows the saved collaboration settings and returns to the lead AI for review.", "总纲提交后按已保存的协作设置进入执行，完成后交回总 AI 审核。")
    : stage === "execute" ? ui(`After this task, remaining tasks run serially. The ${reviewer} performs a final review and requests rework if needed.`, `本项完成后继续串行执行后续任务，全部完成后交给${reviewer}统一审核；有问题再安排返工。`)
      : stage === "review" ? ui("Approval starts the next task automatically; issues return to the implementation AI for changes.", "通过后自动进入下一项任务；有问题则交回执行 AI 修改。")
        : ui(`After the ${reviewer} approves the result, it waits for your acceptance. You can accept, request changes, or reject and end the task.`, `${reviewer}审核通过后等你验收；你可以确认完成、提出修改意见，或不采纳并结束任务。`);
  return {
    stage, actor: stage === "execute" ? ui("Implementation AI", "执行 AI") : stage === "plan" ? context.reviewer?.separateSession ? ui("Planning AI", "设计 AI") : ui("Lead AI", "总 AI") : reviewer, goal: context.goal, cwd: context.cwd, ...(context.branch ? { branch: context.branch } : {}), team,
    ...(context.task ? { task: context.task.title, description: context.task.description } : {}),
    ...(context.userChangeRequests?.length ? { changes: context.userChangeRequests.map(change => change.feedback) } : {}),
    ...(context.preInstructions?.length ? { preInstructions: context.preInstructions } : {}),
    acceptance: (stage === "final" ? context.acceptance ?? context.plan?.acceptance : context.task?.acceptance) ?? [],
    files: context.task?.files ?? [], next, raw,
  };
}
