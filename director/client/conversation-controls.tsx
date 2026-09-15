import { View } from "react-native";
import { useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { resyncConversationRpc, getConversationRpc } from "../shared/rpc";
import { Button, ErrorText, Label } from "./ui";

export const ConversationLinkSchema = z.object({ conversationId: z.string() });

// Keep links from legacy history and recovery errors; child navigation belongs
// to Paseo's native subagent control.
export function createConversationRenderer() {
  return function ConversationLink({ item, theme, agentId, host }: PluginTimelineItemProps<z.infer<typeof ConversationLinkSchema>>) {
    const get = useRpc(getConversationRpc), resync = useRpc(resyncConversationRpc);
    const sync = useMutation({ mutationFn: resync });
    const query = useQuery({ queryKey: ["director", host.id, "conversation", item.data.conversationId], queryFn: () => get({ id: item.data.conversationId }), refetchInterval: 2500 });
    const summary = query.data;
    const error = query.error ?? summary?.error ?? sync.error;
    const migrated = summary?.agentId && summary.agentId !== agentId;
    if (!error && !migrated) return null;
    return <View style={{ gap: 8 }}>
      <ErrorText theme={theme} error={error} />
      {summary?.error && <Button theme={theme} secondary label="重新同步到主对话" disabled={sync.isPending} onPress={() => sync.mutate({ id: summary.id })} />}
      {migrated && <Label theme={theme}>此任务已迁移，请从工作区会话列表打开主对话：{summary.title}。</Label>}
    </View>;
  };
}
export function installConversationControls(client: PluginClientContext) {
  const headers = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  let disposed = false, polling = false;
  const poll = async () => {
    if (disposed || polling) return; polling = true;
    try {
      const live = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      // The host scopes header buttons to workspaces. Include every workspace,
      // even when it has never had a Director conversation or an agent.
      do {
        const page = await client.paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        if (disposed) return;
        for (const workspace of page.entries) if (!workspace.archivingAt) live.add(workspace.id);
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
        if (page.pageInfo.hasMore && (!cursor || cursors.has(cursor))) throw new Error("工作区列表读取不完整");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      for (const workspaceId of live) {
        if (!headers.has(workspaceId)) headers.set(workspaceId, client.addHeaderButton({ id: "director-settings", workspaceId,
          button: { title: "协作设置", icon: "Settings", behavior: { kind: "action", onPress: () => client.openSettings("director-settings") } } }));
      }
      for (const [id, registration] of headers) if (!live.has(id)) { registration.remove(); headers.delete(id); }
    } catch (error) { console.warn("Director controls:", error instanceof Error ? error.message : String(error)); }
    finally { polling = false; }
  };
  const renderer = client.addTimelineRenderer({ kind: "director-conversation", version: 1, schema: ConversationLinkSchema, Component: createConversationRenderer() });
  void poll(); const timer = setInterval(() => { void poll(); }, 2500);
  return () => { disposed = true; clearInterval(timer); renderer(); for (const r of headers.values()) r.remove(); };
}
