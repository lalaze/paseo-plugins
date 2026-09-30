import type { PluginClientContext, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { useWorkspace } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import { TodoPanel } from './panel';
import { ui } from './i18n';

type Rpc = PluginClientContext['rpc'];

/** Tasks for the workspace's project, shown beside Files and Changes. Tasks still target the project root, not this checkout. */
export function WorkspaceTodoPanel(props: PluginWorkspacePanelProps & { rpc: Rpc }) {
  const project = useWorkspace(props.workspaceId, workspace => ({
    git: workspace.projectKind === 'git', repository: workspace.projectRootPath, name: workspace.projectDisplayName,
  }));
  const colors = props.theme.colors;
  if (project === null) {
    return <Notice color={colors.foregroundMuted} text={ui('Loading workspace…', '正在读取工作区…')} />;
  }
  if (!project.git) {
    return <Notice color={colors.foregroundMuted} text={ui('Tasks need a git project.', '待办任务需要 git 项目。')} />;
  }
  return <TodoPanel key={`${props.host.id}:${project.repository}`} {...props}
    scope={{ repository: project.repository, name: project.name || project.repository }} />;
}

function Notice(props: { color: string; text: string }) {
  return <View style={{ padding: 16 }}>
    <Text style={{ color: props.color }}>{props.text}</Text>
  </View>;
}
