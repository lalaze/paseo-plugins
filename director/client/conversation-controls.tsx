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
  return client.addTimelineRenderer({ kind: "director-conversation", version: 1, schema: ConversationLinkSchema, Component: createConversationRenderer() });
}
