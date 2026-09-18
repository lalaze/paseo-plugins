import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerTranslationClient } from './client/selection';
import { runtimeInfoRpc } from './shared/rpc';

export default function contribute(client: PluginClientContext) {
  let disposed = false, unregister = () => {};
  void client.rpc(runtimeInfoRpc, {}).then(({ serverId }) => {
    if (!disposed && serverId) unregister = registerTranslationClient(serverId, client);
  }).catch(() => {});
  return () => { disposed = true; unregister(); };
}
