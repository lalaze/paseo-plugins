import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerTranslationClient } from './client/selection';
import { TranslationSettingsScreen } from './client/settings';
import { runtimeInfoRpc } from './shared/rpc';

export default function contribute(client: PluginClientContext) {
  let disposed = false, unregister = () => {};
  const unregisterSettings = client.addSettingsScreen({ id: 'translate-settings', title: '翻译 API', icon: 'Settings', Component: TranslationSettingsScreen });
  void client.rpc(runtimeInfoRpc, {}).then(({ serverId }) => {
    if (!disposed && serverId) unregister = registerTranslationClient(serverId, client);
  }).catch(() => {});
  return () => { disposed = true; unregister(); unregisterSettings(); };
}
