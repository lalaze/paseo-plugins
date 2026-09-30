import type { PluginServerContext } from '@getpaseo/plugin/server';
import { listProviderUpdates, updateProvider } from './shared/rpc';
import { ProviderUpdates } from './server/updater';

export default function contribute(server: PluginServerContext) {
  const updates = new ProviderUpdates();
  server.handle(listProviderUpdates, ({ refresh }, { paseo }) => updates.list(paseo.providers, refresh));
  server.handle(updateProvider, ({ provider }, { paseo }) => updates.update(paseo.providers, provider));
  // An upgrade in flight is left to finish: stopping npm or a self-updater midway can leave a broken install.
  return () => undefined;
}
