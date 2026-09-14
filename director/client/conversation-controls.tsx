import { View } from "react-native";
import { useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { resyncConversationRpc, getConversationRpc, listConversationsRpc } from "../shared/rpc";
import { Button, ErrorText } from "./ui";
import type { LaunchRequests } from "./launch";

export const ConversationLinkSchema = z.object({ conversationId: z.string() });
type OpenAgent = (workspaceId: string, agentId: string) => void;

// Keep links from legacy history and recovery errors; child navigation belongs
// to Paseo's native subagent control.
export function createConversationRenderer(openAgent: OpenAgent) {
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
      {migrated && <Button theme={theme} label="进入新的主对话" onPress={() => openAgent(summary.workspaceId, summary.agentId!)} />}
    </View>;
  };
}
export function installConversationControls(client: PluginClientContext, requests: LaunchRequests) {
  const headers = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  let disposed = false, polling = false;
  const openAgent: OpenAgent = (workspaceId, agentId) => {
    requests.set(workspaceId, { status: "created", requestId: `navigation-${agentId}`, goal: "", agentId });
    client.openPanel("director", { workspaceId });
  };
  const poll = async () => {
    if (disposed || polling) return; polling = true;
    try {
      const chats = await client.rpc(listConversationsRpc, {});
      if (disposed) return;
      const live = new Set<string>();
      for (const c of chats) {
        if (!c.agentId) continue;
        live.add(c.workspaceId);
        if (!headers.has(c.workspaceId)) headers.set(c.workspaceId, client.addHeaderButton({ id: "director-settings", workspaceId: c.workspaceId,
          button: { title: "协作设置", icon: "Settings", behavior: { kind: "action", onPress: () => client.openSettings("director-settings") } } }));

      }
      for (const [id, registration] of headers) if (!live.has(id)) { registration.remove(); headers.delete(id); }
    } catch (error) { console.warn("Director controls:", error instanceof Error ? error.message : String(error)); }
    finally { polling = false; }
  };
  const renderer = client.addTimelineRenderer({ kind: "director-conversation", version: 1, schema: ConversationLinkSchema, Component: createConversationRenderer(openAgent) });
  void poll(); const timer = setInterval(() => { void poll(); }, 2500);
  return () => { disposed = true; clearInterval(timer); renderer(); for (const r of headers.values()) r.remove(); };
}
