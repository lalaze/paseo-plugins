import type { PluginServerContext } from '@getpaseo/plugin/server';
import { list, start, chunk, finish, cancel, download, disposeServer } from './server/register.server';
import * as rpc from './shared/files.shared';

export default function contribute(server: PluginServerContext) {
  server.handle(rpc.listFiles, list);
  server.handle(rpc.startUpload, start);
  server.handle(rpc.uploadChunk, chunk);
  server.handle(rpc.finishUpload, finish);
  server.handle(rpc.cancelUpload, cancel);
  server.handle(rpc.downloadChunk, download);
  return disposeServer;
}
