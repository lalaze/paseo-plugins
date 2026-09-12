import type { Operation, Run } from "./schema";

export type InstructionRole = "plan" | "execute" | "review";
export const instructionRoles: Record<InstructionRole, { label: string; description: string; example: string }> = {
  plan: {
    label: "设计 AI",
    description: "制定总纲或根据修改意见重新设计时使用。",
    example: "先阅读项目说明和现有实现，再制定可执行的方案。优先复用已有结构，写清修改范围、接口、依赖关系和验收标准。按用户配置的任务类型拆分工作，只制定方案，不直接修改源代码。",
  },
  execute: {
    label: "执行 AI",
    description: "所有执行者在实现、返工和追加修改时使用，包括按类型指定的 AI。",
    example: "动手前阅读相关代码和项目约定，优先复用现有实现。围绕当前任务做必要修改，保留已有功能与用户改动。完成后运行与改动相关的验证，说明改了什么、实际验证结果和仍有的问题。不要修改测试来掩盖失败；遇到真实阻碍时说明原因。",
  },
  review: {
    label: "审核 AI",
    description: "每项任务审核、返工复审和最终审核时使用；沿用设计会话也会应用。",
    example: "逐项对照验收标准，独立检查实际代码、差异和执行报告，按需运行测试或构建。重点检查功能遗漏、边界情况、回归风险和验证证据。问题需注明位置、具体修改要求及复验方法；只审核，不修改源代码。通过时写清依据，未验证的部分如实说明，不把推测当成已通过。",
  },
};

export type PreInstruction = { source: string; text: string };

/** Resolve by the operation, not the session's role: design can share a session with review. */
export function preInstructionsFor(run: Run, kind: Operation["kind"], taskId?: string): PreInstruction[] {
  const role = kind === "final" ? "review" : kind;
  const roleText = run.settings.rolePrompts?.[role]?.trim();
  const profileId = kind === "execute" ? run.tasks.find(task => task.spec.id === taskId)?.profileId
    : kind === "plan" ? run.settings.directorProfileId : run.settings.reviewerProfileId ?? run.settings.directorProfileId;
  const profile = run.settings.profiles.find(entry => entry.id === profileId);
  const agentText = profile?.instructions?.trim();
  return [
    ...(roleText ? [{ source: `${instructionRoles[role].label}前置提示词`, text: roleText }] : []),
    ...(agentText ? [{ source: `${profile!.label}的补充提示词`, text: agentText }] : []),
  ];
}
