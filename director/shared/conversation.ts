import { awaitingAcceptance, type Run, type Settings } from "./schema";

export type Confirmation = { key: string; kind: "plan" | "final"; noticeId: string; artifactId?: string; planVersion?: number };
export type Conversation = {
  id: string; requestId: string; workspaceId: string; cwd: string; agentId?: string;
  settings: Settings; runId?: string; createdAt: number;
  state: "creating" | "ready" | "migration_pending";
  generation?: number; previousAgentIds?: string[];
  linksReady?: boolean;
  takeover?: { instruction?: string; messages: { id: string; text: string; automatic?: boolean; state: "pending" | "sending" | "sent" }[] };
  toolsConnectedAt?: number;
  error?: string; initialGoal?: string; initialDelivered?: boolean;
  legacyAgentId?: string; noticeKey?: string; confirmation?: Confirmation;
  notices: { id: string; key: string; text: string; state: "pending" | "sending" | "sent"; attempts?: number }[];
  receipts: Record<string, { action: string; state: "pending" | "done"; value?: unknown; goal?: string }>;
};
export type ConversationSummary = Pick<Conversation, "id" | "workspaceId" | "agentId" | "runId" | "state" | "error"> & {
  title: string; run?: Run; confirmation?: Confirmation;
};
export const CHAT_ACTOR = "role:chat";
export const CHAT_MARKER = "[paseo-director-chat:";
export function confirmationFor(run: Run): Omit<Confirmation, "noticeId"> | undefined {
  if (run.control === "paused" && run.plan && !run.planApproved) return { kind: "plan", key: `plan:${run.planVersion ?? 1}:${JSON.stringify(run.plan)}`, planVersion: run.planVersion ?? 1 };
  if (awaitingAcceptance(run)) return { kind: "final", key: `final:${run.finalEvidence!.id}`, artifactId: run.finalEvidence!.id };
}

