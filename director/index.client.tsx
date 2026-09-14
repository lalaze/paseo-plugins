import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DirectorPanel, DirectorSurface } from "./client/main";
import { createDirectorCommand } from "./client/launch";
import { readDirectorPrompt, PromptCardSchema } from "./client/prompt-model";
import { DirectorPromptCard } from "./client/prompt-card";
import { readDirectorReply, ReplyCardSchema } from "./client/reply-model";
import { DirectorReplyCard } from "./client/reply-card";
import { readDirectorReplyPreview } from "./client/reply-preview";

export default function contribute(client: PluginClientContext) {
  const command = createDirectorCommand();
  client.addTimelineTransformer({ id: "director-prompts", query: { itemType: "user_message" }, transform: ({ item }) => {
    const data = readDirectorPrompt(item.text);
    return data ? { items: [{ type: "plugin", kind: "director-prompt", version: 1, data }] } : undefined;
  } });
  client.addTimelineRenderer({ kind: "director-prompt", version: 1, schema: PromptCardSchema, Component: DirectorPromptCard });
  client.addTimelineTransformer({ id: "director-replies", query: { itemType: "assistant_message" }, transform: ({ item }) => {
    const data = readDirectorReply(item.text) ?? readDirectorReplyPreview(item.text);
    return data ? { items: [{ type: "plugin", kind: "director-reply", version: 1, data }] } : undefined;
  } });
  client.addTimelineRenderer({ kind: "director-reply", version: 1, schema: ReplyCardSchema, Component: DirectorReplyCard });
  client.addSurface("director", DirectorSurface);
  client.addWorkspacePanel({ id: "director", title: "AI 协作", icon: "Workflow", context: "workspace", Component: props => <DirectorPanel {...props} requests={command.requests} /> });
  client.addCommandCenterItem({ id: "open-director", title: "AI 协作：安排任务", icon: "Workflow", context: "workspace", onSelect: ({ openPanel }) => openPanel("director") });
  client.addSlashCommand({ name: "director", description: "使用已保存的 AI 分工下发任务；留空打开面板", argumentHint: "任务描述", context: "workspace", onSubmit: command.submit });
  return () => command.dispose();
}
