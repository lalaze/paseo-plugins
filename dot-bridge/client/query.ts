import { QueryClient, queryOptions } from '@tanstack/react-query';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { connectionStatus, taskList } from '../shared/rpc';

export type BridgeRpc = PluginClientContext['rpc'];

/**
 * One QueryClient per plugin contribution. Connection facts and the task list refresh on a slow
 * tick; the task list key includes the workspace so a workspace panel and the global page do not
 * share a cache entry.
 */
export function createBridgeQuery(rpc: BridgeRpc) {
  const client = new QueryClient();
  client.mount();
  const connectionOptions = queryOptions({
    queryKey: ['dot-bridge', 'connection'],
    queryFn: () => rpc(connectionStatus, {}),
    refetchInterval: 4000,
    retry: 1,
  });
  const tasksOptionsFor = (workspaceId: string | null) => queryOptions({
    queryKey: ['dot-bridge', 'tasks', workspaceId],
    queryFn: () => rpc(taskList, { workspaceId }),
    refetchInterval: 4000,
    retry: 1,
  });
  /** Unmounts the client so its interval timers stop when the plugin contribution is removed. */
  const dispose = () => client.unmount();
  return { client, connectionOptions, tasksOptionsFor, dispose };
}

export type BridgeQuery = ReturnType<typeof createBridgeQuery>;
