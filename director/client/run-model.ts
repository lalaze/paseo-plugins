import { awaitingAcceptance, executionComplete, type Run, type RunSummary } from "../shared/schema";

export const phaseLabels: Record<string, string> = { planning: "设计总纲", executing: "执行任务", reviewing: "审核任务", final_review: "统一审核", awaiting_acceptance: "等待你验收", completed: "已完成", running: "进行中", paused: "已暂停", waiting_permission: "等待权限 / 回答", needs_attention: "需要处理", canceling: "正在停止", canceled: "已结束", pending: "等待执行", executed: "已执行，待统一审核", approved: "已通过" };
export type StatusTone = "accent" | "success" | "warning" | "danger" | "muted";

export function runStatus(run: Pick<RunSummary, "phase" | "control">): { label: string; tone: StatusTone } {
  if (run.control === "canceled") return { label: "已结束", tone: "muted" };
  if (run.control === "canceling") return { label: "正在停止", tone: "warning" };
  if (run.control === "needs_attention") return { label: "需要处理", tone: "danger" };
  if (run.control === "waiting_permission") return { label: "等待权限 / 回答", tone: "warning" };
  if (run.phase === "awaiting_acceptance") return { label: "等待你验收", tone: "warning" };
  if (run.phase === "completed") return { label: "已完成", tone: "success" };
  if (run.control === "paused") return { label: "已暂停", tone: "warning" };
  return { label: phaseLabels[run.phase], tone: "accent" };
}

export function runPresentation(run: Run) {
  const awaitingFinal = awaitingAcceptance(run);
  const ended = run.control === "canceled" || (run.phase === "completed" && !awaitingFinal);
  const awaitingPlan = !ended && run.control === "paused" && !!run.plan && !run.planApproved;
  const status = awaitingPlan ? { label: "等待你确认总纲", tone: "warning" as const }
    : runStatus({ ...run, phase: awaitingFinal ? "awaiting_acceptance" : run.phase });
  const stage = awaitingPlan ? 0 : awaitingFinal || run.phase === "completed" || run.phase === "awaiting_acceptance" ? 3
    : run.phase === "final_review" ? 2 : run.phase === "planning" ? 0 : 1;
  let next = "AI 正在推进任务，进度会自动更新。";
  if (run.control === "canceled") next = "任务已结束，现有文件和成果分支已保留。";
  else if (run.control === "canceling") next = "正在停止当前步骤，请等待状态更新。";
  else if (run.control === "needs_attention") next = "请先查看下方原因，必要时打开 AI 会话处理，检查后重试当前步骤。";
  else if (run.control === "waiting_permission") next = "请打开当前 AI 会话，处理权限请求或回答问题；处理后会自动继续。";
  else if (awaitingFinal) next = "AI 已完成审核。请查看成果与审核依据，再验收或提交修改意见。";
  else if (run.phase === "completed") next = run.userAcceptance?.decision === "approved" ? "你已验收通过；如需调整，可以继续提交修改意见。" : "任务已完成，请查看保存的成果和运行记录。";
  else if (awaitingPlan) next = "请查看下方设计总纲与验收要求，确认后开始执行。";
  else if (run.control === "paused") next = "后续派发已暂停，当前 AI 仍可能完成本轮。准备好后点击「继续」。";
  return { status, stage, next, ended, awaitingPlan, awaitingFinal, done: run.tasks.filter(executionComplete).length };
}

export function createRunHint(input: { goal: string; directory: string; needsWorkspace: boolean }): string | null {
  if (input.needsWorkspace) return "先选择一个已有工作区，或切换到独立工作区。";
  if (!input.directory.trim()) return "请填写主机上的 Git 仓库绝对路径。";
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(input.directory.trim())) return "仓库路径需要使用绝对路径，例如 /home/me/project。";
  if (!input.goal.trim()) return "写下目标与验收要求，就可以开始协作。";
  if (input.goal.trim().length > 32000) return "任务描述最多 32000 个字符，请缩短后提交。";
  return null;
}
