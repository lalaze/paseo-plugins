import type { AgentStreamEvent, AgentUsage } from "@getpaseo/protocol/agent-types";
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
  lastOutputAt: number | null;
  outputEvents: number;
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
    lastOutputAt: null,
    outputEvents: 0,
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

export function observeTimelineEvent(tracker: TurnTracker, update: TimelineEvent, receivedAt = Date.now()): void {
  if (update.agentId !== tracker.agentId || update.event.type === "replacement") return;
  const event = update.event;
  if (!belongsToTurn(tracker, event)) return;
  const at = timestamp(update.timestamp, receivedAt);

  if (event.type === "timeline" && (event.item.type === "assistant_message" || event.item.type === "reasoning")) {
    tracker.firstOutputAt ??= at;
    tracker.lastOutputAt = at;
    tracker.outputEvents += 1;
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
  const observedStreamMs = tracker.firstOutputAt !== null && tracker.lastOutputAt !== null
    ? Math.round(tracker.lastOutputAt - tracker.firstOutputAt)
    : 0;
  // A single/final-only event does not prove a streaming interval. Avoid an
  // artificially huge rate from two events delivered in the same tick.
  const streamMs = tracker.outputEvents >= 2 && observedStreamMs >= 100 ? observedStreamMs : null;
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
