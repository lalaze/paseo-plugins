import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { FileService } from './files.server';

const service = new FileService();
async function root(workspaceId: string, context: PluginHandlerContext) {
  const workspace = await context.paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory) throw new Error('The current workspace is unavailable');
  return workspace.workspaceDirectory;
}
export async function list(input: { workspaceId: string; path: string }, context: PluginHandlerContext) { return service.list(await root(input.workspaceId, context), input.path); }
export async function start(input: { workspaceId: string; path: string; size: number }, context: PluginHandlerContext) { return service.start(await root(input.workspaceId, context), input.path, input.size); }
export function chunk(input: { id: string; offset: number; data: string }) { return service.chunk(input.id, input.offset, input.data); }
export function finish(input: { id: string }) { return service.finish(input.id); }
export function cancel(input: { id: string }) { return service.cancel(input.id); }
export async function download(input: { workspaceId: string; path: string; offset: number; version?: string }, context: PluginHandlerContext) { return service.download(await root(input.workspaceId, context), input.path, input.offset, input.version); }
export function disposeServer() { return service.dispose(); }
