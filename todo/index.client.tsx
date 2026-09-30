import { useEffect } from 'react';
import type { PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { sharedHostRegistry } from './client/hosts';
import { TodoPanel } from './client/panel';
import { WorkspaceTodoPanel } from './client/workspace';
import { ui } from './client/i18n';
import { readHostIdentity } from './shared/rpc';

export default function contribute(client: PluginClientContext) {
  // This copy of the bundle serves one host; register it so any host's Tasks page can gather this host's tasks.
  const registry = sharedHostRegistry();
  const registration = registry.register(client.rpc);
  void client.rpc(readHostIdentity, {})
    .then(identity => { if (identity.id) registration.identify({ id: identity.id, label: identity.label }); })
    .catch(() => undefined);

  const Surface = (props: PluginSurfaceProps) => {
    // The app's own id and name for this host are authoritative once its page is shown.
    useEffect(() => { registration.identify({ id: props.host.id, label: props.host.label }); }, [props.host.id, props.host.label]);
    return <TodoPanel {...props} rpc={client.rpc} registry={registry} />;
  };
  const Panel = (props: PluginWorkspacePanelProps) => <WorkspaceTodoPanel {...props} rpc={client.rpc} />;
  const removeSurface = client.addSurface('todo', Surface);
  const removeSidebar = client.addSidebarItem({ id: 'todo', title: ui('Tasks', '待办任务'), icon: 'ListTodo', surface: 'todo' });
  const removePanel = client.addWorkspacePanel({
    id: 'todo', title: ui('Tasks', '待办任务'), icon: 'ListTodo', context: 'workspace', locations: ['explorer'], Component: Panel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-todo', title: ui('Open tasks', '打开待办任务'), icon: 'ListTodo', context: 'global',
    keywords: ['todo', 'task', '待办', '任务'], onSelect: () => client.openSurface('todo'),
  });
  const removeWorkspaceCommand = client.addCommandCenterItem({
    id: 'open-todo-panel', title: ui('Tasks for this project', '本项目的待办任务'), icon: 'ListTodo', context: 'workspace',
    keywords: ['todo', 'task', 'panel', '待办', '任务'], onSelect: ({ openPanel }) => openPanel('todo', { location: 'explorer' }),
  });
  return () => {
    registration.dispose();
    removeWorkspaceCommand(); removeCommand(); removePanel(); removeSidebar(); removeSurface();
  };
}
