import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ProviderUpdatesPage } from './client/page';
import { ui } from './shared/i18n';

export default function contribute(client: PluginClientContext) {
  const Page = (props: PluginSurfaceProps) => <ProviderUpdatesPage {...props} rpc={client.rpc} />;
  const removeSettings = client.addSettingsScreen({ id: 'provider-updates', title: ui('Provider updates', 'Provider 更新'), icon: 'CircleArrowUp', Component: Page });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-provider-updates', title: ui('Update providers', '更新 Provider'), icon: 'CircleArrowUp', context: 'global',
    keywords: ['update', 'upgrade', 'provider', 'claude', 'codex', 'version', '更新', '升级'],
    onSelect: () => client.openSettings('provider-updates'),
  });
  return () => { removeCommand(); removeSettings(); };
}
