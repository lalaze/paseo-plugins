import { z } from 'zod';
import { attachmentSchema } from './shared/attachments';
import { AttachmentPanel } from './client/attachments';
import type { PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { DotBridgePanel } from './client/panel';
import { createBridgeQuery } from './client/query';
import { DotBridgeSettingsScreen } from './client/settings';
import { ui } from './client/i18n';

/** Sidebar page, workspace explorer panel, settings screen and a command-center entry. */
export default function contribute(client: PluginClientContext) {
  const query = createBridgeQuery(client.rpc);
  const removeAttachmentRenderer = client.addTimelineRenderer({
    kind: 'dot-attachment', version: 1,
    schema: z.object({ taskId: z.string().uuid(), attachment: attachmentSchema }).strict(),
    Component: props => <AttachmentPanel colors={props.theme.colors} rpc={client.rpc}
      task={{ id: props.item.data.taskId, currentRoundId: props.item.data.attachment.roundId, revision: 0, attachments: [props.item.data.attachment] }}
      readOnly refresh={async () => {}} />,
  });
  const Surface = (props: PluginSurfaceProps) => {
    return <DotBridgePanel {...props} rpc={client.rpc} paseo={client.paseo} query={query} workspaceId={null} />;
  };
  const Panel = (props: PluginWorkspacePanelProps) => {
    return <DotBridgePanel {...props} rpc={client.rpc} paseo={client.paseo} query={query} workspaceId={props.workspaceId} />;
  };
  const removeSurface = client.addSurface('dot-bridge', Surface);
  const removeSidebar = client.addSidebarItem({ id: 'dot-bridge', title: ui('Dot tasks', 'Dot 任务'), icon: 'Blocks', surface: 'dot-bridge' });
  const removePanel = client.addWorkspacePanel({
    id: 'dot-bridge',
    title: ui('Dot tasks', 'Dot 任务'),
    icon: 'Blocks',
    context: 'workspace',
    locations: ['explorer'],
    Component: Panel,
  });
  const removeSettings = client.addSettingsScreen({ id: 'dot-bridge', title: ui('Dot Bridge', 'Dot Bridge'), icon: 'Blocks', Component: DotBridgeSettingsScreen });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-dot-bridge',
    title: ui('Open Dot tasks', '打开 Dot 任务'),
    icon: 'Blocks',
    context: 'global',
    keywords: ['dot', 'bridge', 'task', '任务'],
    onSelect: () => client.openSurface('dot-bridge'),
  });
  return () => {
    removeAttachmentRenderer();
    removeCommand();
    removeSettings();
    removePanel();
    removeSidebar();
    removeSurface();
    query.dispose();
  };
}
