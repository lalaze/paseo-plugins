import type { PaseoAgentHandle, PaseoAgentTimelineSubscription } from "@getpaseo/client";
import type { PluginHookAgent, PluginHookContext, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import {
  acceptSnapshotUsage,
  createTurnTracker,
  finishTurn,
  observeTimelineEvent,
  type ResponseSpeedData,
  type TurnTracker,
} from "../shared/metrics";

interface ActiveTurn {
  tracker: TurnTracker;
  handle: PaseoAgentHandle;
  subscription: PaseoAgentTimelineSubscription;
}

const outcomeStatus = (outcome: PluginTurnOutcome): ResponseSpeedData["status"] => outcome.kind;
const modelFrom = (handle: PaseoAgentHandle) => handle.runtimeInfo?.model ?? handle.current()?.model ?? null;

export class ResponseSpeedTracker {
  private readonly active = new Map<string, ActiveTurn>();
  private stopped = false;

  start(agent: PluginHookAgent, turnId: string | null, context: PluginHookContext): void {
    this.release(agent.id);
    if (this.stopped) return;
    const handle = context.paseo.agents.ref(agent.id);
    const tracker = createTurnTracker({ agentId: agent.id, provider: agent.provider, turnId });
    const subscription = handle.timeline.subscribe(update => observeTimelineEvent(tracker, update));
    const active = { tracker, handle, subscription };
    this.active.set(agent.id, active);

    void subscription.ready.catch(() => undefined);
    void handle.refresh().then(result => {
      if (this.active.get(agent.id) !== active || !result?.agent) return;
      tracker.model = result.agent.runtimeInfo?.model ?? result.agent.model ?? tracker.model;
      const sameTurn = !turnId || result.agent.activeTurn?.turnId === turnId;
      if (sameTurn && result.agent.status === "running") {
        const startedAt = result.agent.activeTurn?.startedAt
          ? Date.parse(result.agent.activeTurn.startedAt)
          : Number.NaN;
        if (Number.isFinite(startedAt)) tracker.startedAt = startedAt;
        tracker.baselineUsage = result.agent.lastUsage ?? null;
      }
    }).catch(() => undefined);
  }

  async end(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: PluginTurnOutcome,
  ): Promise<ResponseSpeedData | null> {
    const active = this.active.get(agent.id);
    if (!active || (active.tracker.turnId && turnId && active.tracker.turnId !== turnId)) return null;
    this.active.delete(agent.id);

    // The terminal stream event and lifecycle hook use separate transports.
    // Give the stream callback one event-loop turn, then use the persisted
    // snapshot as a conservative fallback.
    await new Promise(resolve => setTimeout(resolve, 25));
    try {
      await active.handle.refresh();
      active.tracker.model = modelFrom(active.handle) ?? active.tracker.model;
      acceptSnapshotUsage(active.tracker, active.handle.lastUsage as AgentUsage | null);
    } catch {
      // Duration-only cards are still useful when the snapshot is unavailable.
    } finally {
      active.subscription();
    }

    return finishTurn(active.tracker, outcomeStatus(outcome));
  }

  stop(): void {
    this.stopped = true;
    for (const agentId of [...this.active.keys()]) this.release(agentId);
  }

  private release(agentId: string): void {
    const active = this.active.get(agentId);
    if (!active) return;
    this.active.delete(agentId);
    active.subscription();
  }
}
