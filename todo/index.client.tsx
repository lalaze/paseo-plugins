import type { PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { TodoPanel } from './client/panel';
import { WorkspaceTodoPanel } from './client/workspace';
import { ui } from './client/i18n';

export default function contribute(client: PluginClientContext) {
  const Surface = (props: PluginSurfaceProps) => <TodoPanel {...props} rpc={client.rpc} />;
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
  return () => { removeWorkspaceCommand(); removeCommand(); removePanel(); removeSidebar(); removeSurface(); };
}
