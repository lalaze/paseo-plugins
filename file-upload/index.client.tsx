import type { PluginClientContext } from '@getpaseo/plugin/client';
import { ui } from './client/i18n';
import { FilePanel } from './client/panel.client';

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: 'files', title: ui('File Transfer', '文件传输'), icon: 'FolderUp', context: 'workspace', locations: ['explorer'], Component: FilePanel });
  client.addCommandCenterItem({ id: 'open-files', title: ui('File Transfer: Upload and Download', '文件传输：上传与下载'), icon: 'FolderUp', context: 'workspace', onSelect: ({ openPanel }) => openPanel('files', { location: 'explorer' }) });
  return () => {};
}
