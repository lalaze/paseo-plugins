import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectionConfig, PaseoGateway } from "../server/paseo.ts";
import { DraftStateSchema } from "../shared/settings-draft.ts";

const config = connectionConfig();
const client = new DaemonClient({ ...config, clientId: "director-smoke", clientType: "cli", reconnect: { enabled: false } });
const gateway = new PaseoGateway(config, () => "http://127.0.0.1:1/mcp");
try {
  await client.connect();
  const plugin = (await client.listPlugins()).find(p => p.id === "paseo-director");
  if (plugin?.status !== "running") throw new Error("Director plugin is not running");
  const settings = await client.invokePluginRpc("paseo-director", "director.settings.get", {});
  DraftStateSchema.parse(await client.invokePluginRpc("paseo-director", "director.settings.draft.get", {}));
  if (settings.error) throw new Error(`Director RPC validation failed: ${settings.error}`);
  await gateway.connect();
  const providers = await gateway.api.providers.snapshot({});
  console.log(JSON.stringify({ plugin: plugin.status, settingsRpc: "ok", draftRpc: "ok", daemonConnection: "ok", providers: providers.entries.length }, null, 2));
} finally { await client.close(); await gateway.close(); }
