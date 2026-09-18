import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStreamEvent } from "@getpaseo/protocol/agent-types";
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

test("computes streaming, end-to-end and TTFT rates from provider usage", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "codex", model: "gpt-5", turnId: "turn-1", startedAt: 1_000 });
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "codex", turnId: "turn-1", item: { type: "reasoning", text: "a" } }, 1_400));
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "codex", turnId: "turn-1", item: { type: "assistant_message", text: "answer" } }, 3_400));
  observeTimelineEvent(tracker, update({ type: "turn_completed", provider: "codex", turnId: "turn-1", usage: { outputTokens: 100 } }, 3_500));

  assert.deepEqual(finishTurn(tracker, "completed", 9_999), {
    provider: "codex",
    model: "gpt-5",
    turnId: "turn-1",
    status: "completed",
    outputTokens: 100,
    totalMs: 2_500,
    ttftMs: 400,
    streamMs: 2_000,
    streamTokensPerSecond: 50,
    totalTokensPerSecond: 40,
  });
});

test("does not invent a streaming interval or token count", () => {
  const tracker = createTurnTracker({ agentId: "agent-1", provider: "claude", startedAt: 10_000 });
  observeTimelineEvent(tracker, update({ type: "timeline", provider: "claude", item: { type: "assistant_message", text: "answer" } }, 10_500));
  const result = finishTurn(tracker, "completed", 12_000);
  assert.equal(result.ttftMs, 500);
  assert.equal(result.streamMs, null);
  assert.equal(result.streamTokensPerSecond, null);
  assert.equal(result.totalTokensPerSecond, null);
  assert.equal(result.outputTokens, null);
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
