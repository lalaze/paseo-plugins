import type { PluginServerContext } from '@getpaseo/plugin/server';
import { runtimeInfoRpc, translateSelectionRpc } from './shared/rpc';
import { readServerId } from './server/host';
import { createTranslationHandler } from './server/translate';

export default function contribute(server: PluginServerContext) {
  server.handle(runtimeInfoRpc, async () => ({ serverId: await readServerId() }));
  server.handle(translateSelectionRpc, createTranslationHandler());
  return () => {};
}
