import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStreamEvent, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  acceptSnapshotUsage,
  createTurnTracker,
  finishTurn,
  observeTimelineEvent,
} from "../shared/metrics";

const update = (event: AgentStreamEvent, at: number, agentId = "agent-1") => ({
  agentId,
  timestamp: new Date(at).toISOString(),
  event,
});

const tool = (
  callId: string,
  status: ToolCallTimelineItem["status"],
  input: Record<string, unknown> = {},
): AgentStreamEvent => ({
  type: "timeline",
  provider: "codex",
  turnId: "turn-1",
  item: status === "running"
    ? { type: "tool_call", callId, name: "shell", status, error: null, detail: { type: "unknown", input, output: null } }
    : { type: "tool_call", callId, name: "shell", status, error: null, detail: { type: "unknown", input, output: {} } },
});

const text = (kind: "reasoning" | "assistant_message", value: string): AgentStreamEvent => ({
  type: "timeline",
  provider: "codex",
  turnId: "turn-1",
  item: { type: kind, text: value },
});

const permission = (id: string): AgentStreamEvent => ({
  type: "permission_requested",
  provider: "codex",
  turnId: "turn-1",
  request: { id, provider: "codex", name: "confirm", kind: "tool" },
});

const resolved = (requestId: string): AgentStreamEvent => ({
  type: "permission_resolved",
  provider: "codex",
  turnId: "turn-1",
  requestId,
  resolution: { behavior: "allow" },
});

const completed = (outputTokens: number): AgentStreamEvent => ({
  type: "turn_completed",
  provider: "codex",
  turnId: "turn-1",
  usage: { outputTokens },
});

test("computes generation, end-to-end and TTFT rates from provider usage", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", model: "gpt-5", turnId: "turn-1", startedAt: 1_000 });
  observeTimelineEvent(tracker, update(text("reasoning", "a"), 1_400));
  observeTimelineEvent(tracker, update(text("assistant_message", "answer"), 3_400));
  observeTimelineEvent(tracker, update(completed(100), 3_500));

  assert.deepEqual(finishTurn(tracker, "completed", 9_999), {
    provider: "codex",
    model: "gpt-5",
    turnId: "turn-1",
    status: "completed",
    outputTokens: 100,
    totalMs: 2_500,
    ttftMs: 400,
    streamMs: 2_500,
    streamTokensPerSecond: 40,
    totalTokensPerSecond: 40,
  });
});

test("bursty output events do not shrink the generation window", () => {
  // Claude delivers summarized reasoning and coalesced text in short bursts
  // long after the model started working on them.
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "claude", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(text("reasoning", "s"), 30_000));
  observeTimelineEvent(tracker, update(text("reasoning", "ummary"), 30_050));
  observeTimelineEvent(tracker, update(text("assistant_message", "a"), 60_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "nswer"), 60_100));
  observeTimelineEvent(tracker, update(completed(3_403), 67_700));

  const result = finishTurn(tracker, "completed");
  assert.equal(result.streamMs, 67_700);
  assert.equal(result.streamTokensPerSecond, 50.3);
  assert.equal(result.ttftMs, 30_000);
});

test("does not invent a token count or a rate without usage", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "claude", startedAt: 10_000 });
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "answer" } }, 10_500));
  const result = finishTurn(tracker, "completed", 12_000);
  assert.equal(result.ttftMs, 500);
  assert.equal(result.streamMs, 2_000);
  assert.equal(result.streamTokensPerSecond, null);
  assert.equal(result.totalTokensPerSecond, null);
  assert.equal(result.outputTokens, null);
});

test("without any observed stream event only the end-to-end rate is reported", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(completed(100), 5_000));
  const result = finishTurn(tracker, "completed");
  assert.equal(result.streamMs, null);
  assert.equal(result.streamTokensPerSecond, null);
  assert.equal(result.totalTokensPerSecond, 20);
});

test("excludes tool execution and permission waits from generation time", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(text("reasoning", "first"), 1_000));
  observeTimelineEvent(tracker, update(text("reasoning", "first continued"), 2_000));
  // Partial tool input keeps streaming; the wait starts at the last change.
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "ls" }), 2_100));
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "ls -la" }), 2_600));
  observeTimelineEvent(tracker, update(tool("tool-1", "completed", { command: "ls -la" }), 12_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "second"), 13_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "second continued"), 15_000));
  observeTimelineEvent(tracker, update(permission("permission-1"), 15_100));
  observeTimelineEvent(tracker, update(resolved("permission-1"), 25_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "final"), 25_500));
  observeTimelineEvent(tracker, update(completed(300), 26_000));

  const result = finishTurn(tracker, "completed");
  assert.equal(result.totalMs, 26_000);
  // 26 000 − (12 000 − 2 600) − (25 000 − 15 100)
  assert.equal(result.streamMs, 6_700);
  assert.equal(result.streamTokensPerSecond, 44.8);
  assert.equal(result.totalTokensPerSecond, 11.5);
});

test("a permission on a running tool keeps the wait open until the tool finishes", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "rm" }), 1_000));
  observeTimelineEvent(tracker, update(permission("permission-1"), 1_050));
  observeTimelineEvent(tracker, update(resolved("permission-1"), 5_000));
  observeTimelineEvent(tracker, update(tool("tool-1", "completed", { command: "rm" }), 8_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "done"), 9_000));
  observeTimelineEvent(tracker, update(completed(100), 9_000));

  const result = finishTurn(tracker, "completed");
  assert.equal(result.streamMs, 2_000);
  assert.equal(result.streamTokensPerSecond, 50);
});

test("parallel tools block generation until the last one finishes", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(tool("tool-a", "running", { command: "a" }), 1_000));
  observeTimelineEvent(tracker, update(tool("tool-b", "running", { command: "b" }), 1_500));
  observeTimelineEvent(tracker, update(tool("tool-a", "completed", { command: "a" }), 3_000));
  observeTimelineEvent(tracker, update(tool("tool-b", "failed", { command: "b" }), 4_000));
  observeTimelineEvent(tracker, update(text("assistant_message", "done"), 5_000));
  observeTimelineEvent(tracker, update(completed(100), 5_000));

  const result = finishTurn(tracker, "completed");
  assert.equal(result.streamMs, 2_500);
  assert.equal(result.streamTokensPerSecond, 40);
});

test("running updates with unchanged input are progress, not generation", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "sleep" }), 1_000));
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "sleep" }), 3_000));
  observeTimelineEvent(tracker, update(tool("tool-1", "completed", { command: "sleep" }), 4_000));
  observeTimelineEvent(tracker, update(completed(100), 5_000));

  const result = finishTurn(tracker, "completed");
  assert.equal(result.streamMs, 2_000);
  assert.equal(result.streamTokensPerSecond, 50);
});

test("a turn canceled while waiting on a tool closes the wait at the end", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "turn-1", startedAt: 0 });
  observeTimelineEvent(tracker, update(tool("tool-1", "running", { command: "sleep" }), 1_000));
  observeTimelineEvent(tracker, update({ type: "turn_canceled", provider: "codex", turnId: "turn-1", reason: "user" }, 4_000));

  const result = finishTurn(tracker, "canceled", 9_000);
  assert.equal(result.totalMs, 4_000);
  assert.equal(result.streamMs, 1_000);
  assert.equal(result.streamTokensPerSecond, null);
});

test("ignores other agents and other turn ids", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", turnId: "wanted", startedAt: 0 });
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "codex", turnId: "wanted", item: { type: "reasoning", text: "other agent" } }, 100, "agent-2"));
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "codex", turnId: "other", item: { type: "assistant_message", text: "other turn" } }, 200));
  assert.equal(tracker.outputEvents, 0);
});

test("uses changed snapshot usage but rejects an unchanged baseline", () => {
  const unchanged = createTurnTracker({ agentId: "agent-1", provider: "codex" });
  unchanged.baselineUsage = { inputTokens: 10, outputTokens: 20 };
  acceptSnapshotUsage(unchanged, { inputTokens: 10, outputTokens: 20 });
  assert.equal(unchanged.usage, null);

  const changed = createTurnTracker({ agentId: "agent-1", provider: "codex" });
  changed.baselineUsage = { inputTokens: 10, outputTokens: 20 };
  acceptSnapshotUsage(changed, { inputTokens: 11, outputTokens: 20 });
  assert.deepEqual(changed.usage, { inputTokens: 11, outputTokens: 20 });
});

test("tracks a model change reported during the turn", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", model: "old" });
  observeTimelineEvent(tracker, update({ type: "model_changed", provider: "codex", runtimeInfo: { provider: "codex", sessionId: "session", model: "new" } }, 1_000));
  assert.equal(tracker.model, "new");
});
