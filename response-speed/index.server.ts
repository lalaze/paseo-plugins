import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ResponseSpeedTracker } from "./server/tracker";

export default function contribute(server: PluginServerContext) {
  const tracker = new ResponseSpeedTracker();
  const removeStarted = server.on("agent.turn_started", (event, context) => {
    tracker.start(event.agent, event.turnId, context);
  });
  const removeEnded = server.on("agent.turn_ended", async (event, context) => {
    const data = await tracker.end(event.agent, event.turnId, event.outcome);
    if (!data) return;
    const suffix = event.turnId ?? `${Date.now()}`;
    await context.paseo.agents.ref(event.agent.id).timeline.append({
      type: "plugin",
      id: `response-speed-${suffix}`,
      kind: "response-speed",
      version: 1,
      data,
    });
  });
  return () => {
    removeStarted();
    removeEnded();
    tracker.stop();
  };
}
