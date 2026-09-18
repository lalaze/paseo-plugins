import type { AgentStreamEvent, AgentUsage, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

export const ResponseSpeedSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  turnId: z.string().nullable(),
  status: z.enum(["completed", "failed", "canceled"]),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalMs: z.number().int().nonnegative(),
  ttftMs: z.number().int().nonnegative().nullable(),
  streamMs: z.number().int().positive().nullable(),
  streamTokensPerSecond: z.number().nonnegative().nullable(),
  totalTokensPerSecond: z.number().nonnegative().nullable(),
});

export type ResponseSpeedData = z.infer<typeof ResponseSpeedSchema>;

export interface TurnTracker {
  agentId: string;
  provider: string;
  model: string | null;
  turnId: string | null;
  startedAt: number;
  firstOutputAt: number | null;
  outputEvents: number;
  observedEvents: number;
  /** callId -> serialized input of the latest running update. */
  runningTools: Map<string, string>;
  pendingPermissions: Set<string>;
  /** When the model stopped generating to wait on tools or approvals. */
  blockedSince: number | null;
  blockedMs: number;
  usage: AgentUsage | null;
  baselineUsage: AgentUsage | null;
  terminalAt: number | null;
}

export function createTurnTracker(input: {
  agentId: string;
  provider: string;
  model?: string | null;
  turnId?: string | null;
  startedAt?: number;
}): TurnTracker {
  return {
    agentId: input.agentId,
    provider: input.provider,
    model: input.model ?? null,
    turnId: input.turnId ?? null,
    startedAt: input.startedAt ?? Date.now(),
    firstOutputAt: null,
    outputEvents: 0,
    observedEvents: 0,
    runningTools: new Map(),
    pendingPermissions: new Set(),
    blockedSince: null,
    blockedMs: 0,
    usage: null,
    baselineUsage: null,
    terminalAt: null,
  };
}

type TimelineEvent = {
  agentId: string;
  timestamp?: string;
  event: AgentStreamEvent | { type: "replacement"; epoch: string };
};

function timestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

function belongsToTurn(tracker: TurnTracker, event: AgentStreamEvent): boolean {
  const id = eventTurnId(event);
  return !tracker.turnId || !id || tracker.turnId === id;
}

// The model-authored part of a tool call. Output/progress fields change while
// the tool executes, which must not look like the model still generating.
function toolInputKey(detail: ToolCallDetail | undefined): string {
  if (!detail) return "";
  switch (detail.type) {
    case "shell": return JSON.stringify([detail.type, detail.command, detail.cwd]);
    case "read": return JSON.stringify([detail.type, detail.filePath, detail.offset, detail.limit]);
    case "edit": return JSON.stringify([detail.type, detail.filePath, detail.oldString, detail.newString]);
    case "write": return JSON.stringify([detail.type, detail.filePath, detail.content]);
    case "search": return JSON.stringify([detail.type, detail.query, detail.toolName, detail.mode]);
    case "fetch": return JSON.stringify([detail.type, detail.url, detail.prompt]);
    case "sub_agent": return JSON.stringify([detail.type, detail.subAgentType, detail.description]);
    case "plan": return JSON.stringify([detail.type, detail.text]);
    case "unknown": return JSON.stringify([detail.type, detail.input]);
    default: return detail.type;
  }
}

function isBlocked(tracker: TurnTracker): boolean {
  return tracker.runningTools.size > 0 || tracker.pendingPermissions.size > 0;
}

function settleBlocked(tracker: TurnTracker, at: number): void {
  if (tracker.blockedSince === null || isBlocked(tracker)) return;
  tracker.blockedMs += Math.max(0, at - tracker.blockedSince);
  tracker.blockedSince = null;
}

export function observeTimelineEvent(tracker: TurnTracker, update: TimelineEvent, receivedAt = Date.now()): void {
  if (update.agentId !== tracker.agentId || update.event.type === "replacement") return;
  const event = update.event;
  if (!belongsToTurn(tracker, event)) return;
  const at = timestamp(update.timestamp, receivedAt);

  if (event.type === "timeline" && (event.item.type === "assistant_message" || event.item.type === "reasoning")) {
    tracker.firstOutputAt ??= at;
    tracker.outputEvents += 1;
    tracker.observedEvents += 1;
    // Output while no approval is pending means the model is generating; a
    // blocked window that was still open was not really a wait.
    if (tracker.blockedSince !== null && tracker.pendingPermissions.size === 0) tracker.blockedSince = at;
    return;
  }
  if (event.type === "timeline" && event.item.type === "tool_call") {
    tracker.observedEvents += 1;
    const item = event.item;
    if (item.status === "running") {
      // Running updates arrive while the tool input is still being generated
      // (Claude streams partial input); the wait starts at the last change.
      const input = toolInputKey(item.detail);
      const previous = tracker.runningTools.get(item.callId);
      tracker.runningTools.set(item.callId, input);
      if (tracker.pendingPermissions.size === 0 && (tracker.blockedSince === null || previous !== input)) {
        tracker.blockedSince = at;
      }
      return;
    }
    tracker.runningTools.delete(item.callId);
    settleBlocked(tracker, at);
    return;
  }
  if (event.type === "permission_requested") {
    tracker.observedEvents += 1;
    tracker.pendingPermissions.add(event.request.id);
    tracker.blockedSince ??= at;
    return;
  }
  if (event.type === "permission_resolved") {
    tracker.observedEvents += 1;
    tracker.pendingPermissions.delete(event.requestId);
    settleBlocked(tracker, at);
    return;
  }
  if (event.type === "usage_updated") {
    tracker.usage = event.usage;
    return;
  }
  if (event.type === "turn_completed") {
    if (event.usage) tracker.usage = event.usage;
    tracker.terminalAt = at;
    return;
  }
  if (event.type === "turn_failed" || event.type === "turn_canceled") {
    tracker.terminalAt = at;
    return;
  }
  if (event.type === "model_changed") {
    tracker.model = event.runtimeInfo.model ?? tracker.model;
  }
}

export function sameUsage(left: AgentUsage | null, right: AgentUsage | null): boolean {
  if (!left || !right) return left === right;
  return left.inputTokens === right.inputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.totalCostUsd === right.totalCostUsd
    && left.contextWindowMaxTokens === right.contextWindowMaxTokens
    && left.contextWindowUsedTokens === right.contextWindowUsedTokens;
}

export function acceptSnapshotUsage(tracker: TurnTracker, usage: AgentUsage | null | undefined): void {
  if (!usage || tracker.usage) return;
  if (tracker.baselineUsage && sameUsage(tracker.baselineUsage, usage)) return;
  tracker.usage = usage;
}

function outputTokens(usage: AgentUsage | null): number | null {
  const value = usage?.outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function rate(tokens: number | null, durationMs: number | null): number | null {
  if (tokens === null || durationMs === null || durationMs <= 0) return null;
  return Math.round((tokens * 1000 / durationMs) * 10) / 10;
}

export function finishTurn(
  tracker: TurnTracker,
  status: ResponseSpeedData["status"],
  finishedAt = Date.now(),
): ResponseSpeedData {
  const completedAt = tracker.terminalAt ?? finishedAt;
  const totalMs = Math.max(0, Math.round(completedAt - tracker.startedAt));
  const ttftMs = tracker.firstOutputAt === null
    ? null
    : Math.max(0, Math.round(tracker.firstOutputAt - tracker.startedAt));
  // Timeline text arrives in bursts (coalesced deltas, summarized reasoning
  // delivered after the fact), so gaps between output events say nothing about
  // generation time. Model time is the turn minus the waits on tools/approvals.
  const blockedMs = tracker.blockedMs
    + (tracker.blockedSince !== null ? Math.max(0, completedAt - tracker.blockedSince) : 0);
  const generationMs = Math.max(0, Math.round(totalMs - blockedMs));
  // Without any observed stream event the tool/permission waits are unknown.
  const streamMs = tracker.observedEvents > 0 && generationMs >= 100 ? generationMs : null;
  const tokens = outputTokens(tracker.usage);
  return {
    provider: tracker.provider,
    model: tracker.model,
    turnId: tracker.turnId,
    status,
    outputTokens: tokens,
    totalMs,
    ttftMs,
    streamMs,
    streamTokensPerSecond: rate(tokens, streamMs),
    totalTokensPerSecond: rate(tokens, totalMs || null),
  };
}
