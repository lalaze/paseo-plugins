import type { PluginClientContext } from '@getpaseo/plugin/client';
import { FilePanel } from './client/panel.client';

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: 'files', title: '文件传输', icon: 'FolderUp', context: 'workspace', locations: ['explorer'], Component: FilePanel });
  client.addCommandCenterItem({ id: 'open-files', title: '文件传输：上传与下载', icon: 'FolderUp', context: 'workspace', onSelect: ({ openPanel }) => openPanel('files', { location: 'explorer' }) });
  return () => {};
}
