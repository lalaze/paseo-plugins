import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { Store } from "./server/store";
import { GitRepository } from "./server/repository";
import { Conversations } from "./server/conversations";
import { Engine } from "./server/engine";
import { PaseoGateway, connectionConfig } from "./server/paseo";
import { DirectorMcp } from "./server/mcp";
import { summarize } from "./shared/schema";
import { resyncConversationRpc, openConversationRpc, getConversationRpc, listConversationsRpc, getSettingsRpc, saveSettingsRpc, getSettingsDraftRpc, writeSettingsDraftRpc, commitSettingsRpc, createRunRpc, listRunsRpc, getRunRpc, getWorkspaceRunRpc, controlRunRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const connection = connectionConfig();
  const root = process.env.PASEO_DIRECTOR_DATA_DIR ?? join(connection.home, "director");
  const store = new Store(join(root, "director.sqlite"));
  let mcp: DirectorMcp;
  const gateway = new PaseoGateway(connection, () => mcp.url());
  const engine = new Engine(store, gateway, new GitRepository(root));
  const conversations = new Conversations(store, engine, gateway);
  mcp = new DirectorMcp(store, engine, conversations);
  let startupError: string | null = null, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined, pumping = false;
  const pump = async () => {
    if (stopped || pumping) return;
    pumping = true;
    try { await conversations.migrate(); await conversations.tick(); await engine.tick(); }
    catch (error) { console.error("Director conversations:", error instanceof Error ? error.message : String(error)); }
    finally { pumping = false; }
  };
  const ready = mcp.start().then(() => { if (!stopped) { timer = setInterval(() => { void pump(); }, 2500); void pump(); } }).catch(error => {
    startupError = `AI 协作后台启动失败：${error instanceof Error ? error.message : String(error)}`;
    console.error(startupError);
  });
  server.handle(openConversationRpc, async (input, context) => { gateway.setPluginApi(context.paseo); await ready; if (startupError) throw new Error(startupError); await conversations.migrate(); return conversations.open(input); });
  server.handle(resyncConversationRpc, ({ id }) => conversations.resync(id));
  server.handle(getConversationRpc, ({ id }) => conversations.summary(id));
  server.handle(listConversationsRpc, ({ workspaceId }) => conversations.list(workspaceId));
  server.handle(getSettingsRpc, (_input, context) => { gateway.setPluginApi(context.paseo); return { settings: store.settings() ?? null, error: startupError }; });
  server.handle(saveSettingsRpc, settings => { store.saveSettings(settings); return { saved: true }; });
  server.handle(getSettingsDraftRpc, () => store.settingsDraft());
  server.handle(writeSettingsDraftRpc, input => store.writeSettingsDraft(input));
  server.handle(commitSettingsRpc, ({ settings, base, draftRevision }) => { store.commitSettings(settings, base, draftRevision); return { saved: true }; });
  server.handle(createRunRpc, async input => { await ready; if (startupError) throw new Error(startupError); return { id: await engine.create(input) }; });
  server.handle(listRunsRpc, ({ offset, limit }) => { const page = store.page(offset, limit); return { runs: page.runs.map(summarize), hasMore: page.hasMore, error: startupError }; });
  server.handle(getRunRpc, ({ id }) => store.get(id));
  server.handle(getWorkspaceRunRpc, ({ workspaceId }) => ({ id: store.workspaceRunId(workspaceId) }));
  server.handle(controlRunRpc, ({ id, action, goal, ...final }) => engine.control(id, action, goal, final));
  // Hooks only wake the durable scheduler; they never wait for an AI turn.
  const wake = () => { void pump(); };
  server.on("agent.created", (_event, context) => { gateway.setPluginApi(context.paseo); });
  server.on("agent.turn_ended", (_event, context) => { gateway.setPluginApi(context.paseo); wake(); });
  server.on("agent.permission_resolved", wake);
  return async () => { stopped = true; if (timer) clearInterval(timer); await ready; await mcp.close(); await conversations.close(); await engine.close(); await gateway.close(); store.close(); };
}
