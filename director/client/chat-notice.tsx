import { Text } from "react-native";
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { Disclosure } from "./settings-controls";
import { Label } from "./ui";
export const ChatNoticeSchema = z.object({ raw: z.string(), title: z.string().optional(), summary: z.string().optional() });
export function ChatNotice({ item, agentId, theme }: PluginTimelineItemProps<z.infer<typeof ChatNoticeSchema>>) {
  const role = useAgent(agentId, a => a.labels["director-role"]);
  if (role !== "chat") return <Text selectable style={{ color: theme.colors.foreground }}>{item.data.raw}</Text>;
  return <Disclosure theme={theme} title={item.data.title ?? "后台协作动态"} summary={item.data.summary ?? "已同步给主 Agent"}><Label theme={theme} muted>{item.data.raw}</Label></Disclosure>;
}
