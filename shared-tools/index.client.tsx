import type { PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { SharedToolsPage } from './client/page';
import { ui } from './shared/i18n';

/** Sidebar page, settings screen, explorer panel, and command-center entries, all showing the same host-wide page. */
export default function contribute(client: PluginClientContext) {
  const title = ui('Shared MCP & skills', '共享 MCP 与技能');
  const keywords = ['mcp', 'skill', 'skills', 'share', 'shared', 'server', 'tools', '共享', '技能', '工具'];
  const Page = (props: PluginSurfaceProps) => <SharedToolsPage {...props} rpc={client.rpc} />;
  const Panel = (props: PluginWorkspacePanelProps) => <SharedToolsPage {...props} rpc={client.rpc} />;
  const removeSurface = client.addSurface('shared-tools', Page);
  const removeSidebar = client.addSidebarItem({ id: 'shared-tools', title, icon: 'Blocks', surface: 'shared-tools' });
  const removeSettings = client.addSettingsScreen({ id: 'shared-tools', title, icon: 'Blocks', Component: Page });
  const removePanel = client.addWorkspacePanel({
    id: 'shared-tools', title, icon: 'Blocks', context: 'workspace', locations: ['explorer'], Component: Panel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-shared-tools', title, icon: 'Blocks', context: 'global', keywords,
    onSelect: () => client.openSurface('shared-tools'),
  });
  const removePanelCommand = client.addCommandCenterItem({
    id: 'open-shared-tools-panel', title: ui('Shared MCP & skills panel', '共享 MCP 与技能面板'), icon: 'Blocks', context: 'workspace',
    keywords: [...keywords, 'panel', '面板'], onSelect: ({ openPanel }) => openPanel('shared-tools', { location: 'explorer' }),
  });
  return () => { removePanelCommand(); removeCommand(); removePanel(); removeSettings(); removeSidebar(); removeSurface(); };
}
