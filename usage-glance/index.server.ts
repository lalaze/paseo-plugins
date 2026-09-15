import type { PluginServerContext } from '@getpaseo/plugin/server';
import { headerSettings } from './shared/settings';
import { readConsumption, enabledConsumptionSources, unsupportedConsumptionProviders } from './shared/consumption';
import { ConsumptionService } from './server/consumption';
import { readHostIdentity } from './shared/hosts';
import { hostIdentity } from './server/host-identity';
import { startConsumptionSync } from './server/consumption-sync';

export default function contribute(server: PluginServerContext) {
  server.registerSettings(headerSettings);
  server.handle(readHostIdentity, () => hostIdentity());
  const consumption = new ConsumptionService();
  const sync = startConsumptionSync(consumption);
  server.handle(readConsumption, async ({ range, refresh }, { paseo }) => {
    const snapshot = await paseo.providers.snapshot().catch(() => { throw new Error('无法读取本机 Providers，请稍后重试'); });
    sync.watch(paseo, range.timezone);
    return { ...consumption.get(range, enabledConsumptionSources(snapshot.entries), refresh), unsupportedProviders: unsupportedConsumptionProviders(snapshot.entries) };
  });
  return () => { sync.dispose(); consumption.dispose(); };
}
