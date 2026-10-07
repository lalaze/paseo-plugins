import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SharedToolsPage } from './client/page';
import { ui } from './shared/i18n';

export default function contribute(client: PluginClientContext) {
  const Page = (props: PluginSurfaceProps) => <SharedToolsPage {...props} rpc={client.rpc} />;
  const removeSettings = client.addSettingsScreen({ id: 'shared-tools', title: ui('Shared MCP & skills', '共享 MCP 与技能'), icon: 'Blocks', Component: Page });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-shared-tools', title: ui('Shared MCP & skills', '共享 MCP 与技能'), icon: 'Blocks', context: 'global',
    keywords: ['mcp', 'skill', 'skills', 'share', 'shared', 'server', 'tools', '共享', '技能', '工具'],
    onSelect: () => client.openSettings('shared-tools'),
  });
  return () => { removeCommand(); removeSettings(); };
}
