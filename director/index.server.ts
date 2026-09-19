import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { Store } from "./server/store";
import { GitRepository } from "./server/repository";
import { Conversations } from "./server/conversations";
import { Engine } from "./server/engine";
import { PaseoGateway, connectionConfig } from "./server/paseo";
import { DirectorMcp } from "./server/mcp";
import { resyncConversationRpc, openConversationRpc, getConversationRpc, getSettingsRpc, getSettingsDraftRpc, writeSettingsDraftRpc, commitSettingsRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const connection = connectionConfig();
  const root = process.env.PASEO_DIRECTOR_DATA_DIR ?? join(connection.home, "director");
  const store = new Store(join(root, "director.sqlite"));
  let mcp: DirectorMcp;
  const gateway = new PaseoGateway(connection, () => mcp.url(), root);
  const engine = new Engine(store, gateway, new GitRepository(root));
  const conversations = new Conversations(store, engine, gateway);
  mcp = new DirectorMcp(store, engine, conversations, root);
  let startupError: string | null = null, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined, pumping = false;
  const report = (stage: string, error: unknown) => console.error(`Director ${stage}:`, error instanceof Error ? error.message : String(error));
  const pump = async () => {
    if (stopped || pumping) return;
    pumping = true;
    try {
      for (const [stage, step] of [["migrate", () => conversations.migrate()], ["conversations", () => conversations.tick()], ["engine", () => engine.tick()]] as const) {
        try { await step(); } catch (error) { report(stage, error); }
      }
    } finally { pumping = false; }
  };
  const ready = mcp.start().then(() => { if (!stopped) { timer = setInterval(() => { void pump(); }, 2500); void pump(); } }).catch(error => {
    startupError = `AI 协作后台启动失败：${error instanceof Error ? error.message : String(error)}`;
    console.error(startupError);
  });
  server.handle(openConversationRpc, async (input, context) => { gateway.setPluginApi(context.paseo); await ready; if (startupError) throw new Error(startupError); await conversations.migrate(); return conversations.open(input); });
  server.handle(resyncConversationRpc, async ({ id }) => { await ready; if (startupError) throw new Error(startupError); return conversations.resync(id); });
  server.handle(getConversationRpc, ({ id }) => conversations.summary(id));
  server.handle(getSettingsRpc, (_input, context) => { gateway.setPluginApi(context.paseo); return { settings: store.settings() ?? null, error: startupError }; });
  server.handle(getSettingsDraftRpc, () => store.settingsDraft());
  server.handle(writeSettingsDraftRpc, input => store.writeSettingsDraft(input));
  server.handle(commitSettingsRpc, ({ settings, base, draftRevision }) => { const draft = store.commitSettings(settings, base, draftRevision); return { saved: true, draft }; });
  // Hooks only wake the durable scheduler; they never wait for an AI turn.
  const wake = () => { void pump(); };
  server.on("agent.created", (_event, context) => { gateway.setPluginApi(context.paseo); });
  server.on("agent.turn_ended", (_event, context) => { gateway.setPluginApi(context.paseo); wake(); });
  server.on("agent.permission_resolved", wake);
  // Release every resource even if one close fails; a retained owner row would
  // block the next plugin load in this same daemon process.
  return async () => {
    stopped = true; if (timer) clearInterval(timer); await ready;
    const failures: unknown[] = [];
    for (const step of [() => mcp.close(), () => conversations.close(), () => engine.close(), () => gateway.close(), async () => store.close()]) {
      try { await step(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  };
}
