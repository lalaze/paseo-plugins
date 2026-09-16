import type { PluginServerContext } from '@getpaseo/plugin/server';
import { headerSettings } from './shared/settings';
import { readConsumption, readWorkspaceConsumption, enabledConsumptionSources, unsupportedConsumptionProviders } from './shared/consumption';
import { ConsumptionService } from './server/consumption';
import { readHostIdentity } from './shared/hosts';
import { hostIdentity } from './server/host-identity';
import { startConsumptionSync } from './server/consumption-sync';
import { readWorkspaceCatalog } from './server/workspace-catalog';
import { readWorkspaceSource } from './server/workspace-consumption';

export default function contribute(server: PluginServerContext) {
  server.registerSettings(headerSettings);
  server.handle(readHostIdentity, () => hostIdentity());
  const consumption = new ConsumptionService();
  let catalog: ReturnType<typeof readWorkspaceCatalog> | undefined;
  let catalogAt = 0;
  const workspaceConsumption = new ConsumptionService(async (source, range, signal) => {
    if (!catalog) throw new Error('本机 Workspace 列表尚未读取');
    return readWorkspaceSource(source, range, signal, await catalog);
  }, Date.now, true);
  const sync = startConsumptionSync(consumption);
  server.handle(readConsumption, async ({ range, refresh }, { paseo }) => {
    const snapshot = await paseo.providers.snapshot().catch(() => { throw new Error('无法读取本机 Providers，请稍后重试'); });
    sync.watch(paseo, range.timezone);
    return { ...consumption.get(range, enabledConsumptionSources(snapshot.entries), refresh), unsupportedProviders: unsupportedConsumptionProviders(snapshot.entries) };
  });
  server.handle(readWorkspaceConsumption, async ({ range, refresh }, { paseo }) => {
    const snapshot = await paseo.providers.snapshot().catch(() => { throw new Error('无法读取本机 Providers，请稍后重试'); });
    if (!catalog || Date.now() - catalogAt >= (refresh ? 5000 : 60000)) {
      catalogAt = Date.now();
      catalog = readWorkspaceCatalog(paseo);
      // Keep RPCs nonblocking while catalog and usage scans complete in the service.
      void catalog.catch(() => { catalogAt = 0; });
    }
    return { ...workspaceConsumption.get(range, enabledConsumptionSources(snapshot.entries), refresh), unsupportedProviders: unsupportedConsumptionProviders(snapshot.entries) };
  });
  return () => { sync.dispose(); consumption.dispose(); workspaceConsumption.dispose(); };
}
