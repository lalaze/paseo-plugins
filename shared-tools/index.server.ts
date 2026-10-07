import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deleteMcpServer, deleteSkill, importMcpServers, importSkill, overwriteSkill, readState, saveMcpServer, syncSkills, updateProvider } from './shared/rpc';
import { sharedToolsDir } from './server/providers';
import { SharedTools } from './server/service';

function report(error: unknown): void {
  console.error('[paseo-shared-tools]', error);
}

export default function contribute(server: PluginServerContext) {
  const tools = new SharedTools(sharedToolsDir(), undefined, report);
  tools.start();

  server.handle(readState, (_input, { paseo }) => tools.state(paseo));
  server.handle(saveMcpServer, ({ previousName, ...server }) => tools.saveServer({ ...server, previousName }));
  server.handle(deleteMcpServer, ({ name }) => tools.deleteServer(name));
  server.handle(importMcpServers, ({ source, json, replace }) => tools.importServers(source, json, replace));
  server.handle(updateProvider, input => tools.updateProvider(input));
  server.handle(importSkill, ({ path, replace }) => tools.importSkill(path, replace));
  server.handle(deleteSkill, ({ name }) => tools.deleteSkill(name));
  server.handle(overwriteSkill, ({ name, provider }) => tools.overwriteSkill(name, provider));
  server.handle(syncSkills, () => tools.syncNow());

  const stopCreate = server.before('agent.create', async ({ request }, { paseo }) => {
    try {
      const added = await tools.mcpFor(request.config.provider, request.config.mcpServers, paseo);
      if (!added) return;
      return { ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, ...added } } };
    } catch (error) {
      // A broken config.json must not stop agents from starting; they start without the shared servers.
      report(error);
      return;
    }
  });

  return () => {
    stopCreate();
    tools.stop();
  };
}
