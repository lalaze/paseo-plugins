import type { Operation, Run } from "./schema";

export type InstructionRole = "plan" | "execute" | "review";
export const instructionRoles: Record<InstructionRole, { label: string; description: string; example: string }> = {
  plan: {
    label: "Planning AI",
    description: "Used when creating the plan or redesigning it from change requests.",
    example: "Read the project documentation and existing implementation before creating an actionable plan. Prefer existing structures and describe the scope, interfaces, dependencies, and acceptance criteria. Split work according to the user's configured task categories. Create the plan only; do not modify source code.",
  },
  execute: {
    label: "Implementation AI",
    description: "Used by every implementer during implementation, rework, and follow-up changes, including category-specific AIs.",
    example: "Read the relevant code and project conventions before editing, and prefer existing implementations. Make only the changes needed for the current task while preserving existing behavior and user work. Run relevant verification afterward, and report what changed, the actual results, and any remaining problems. Do not alter tests to hide failures; explain genuine blockers.",
  },
  review: {
    label: "Review AI",
    description: "Used for the final review and re-review after rework; also applies when reusing the planning conversation.",
    example: "Check each acceptance criterion independently against the actual code, diff, and implementation reports, running tests or builds as needed. Focus on missing behavior, edge cases, regression risk, and verification evidence. For every issue, give the location, required change, and re-verification method. Review only; do not modify source code. Explain the evidence for approval and identify anything not verified instead of treating assumptions as passed.",
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
    ...(roleText ? [{ source: `${instructionRoles[role].label} instructions`, text: roleText }] : []),
    ...(agentText ? [{ source: `Additional instructions for ${profile!.label}`, text: agentText }] : []),
  ];
}
