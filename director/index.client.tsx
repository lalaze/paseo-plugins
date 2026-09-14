import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChatNotice, ChatNoticeSchema } from "./client/chat-notice";
import { installConversationControls } from "./client/conversation-controls";
import { DirectorPanel, DirectorSurface } from "./client/main";
import { createDirectorCommand } from "./client/launch";
import { readDirectorPrompt, PromptCardSchema } from "./client/prompt-model";
import { DirectorPromptCard } from "./client/prompt-card";
import { readDirectorReply, ReplyCardSchema } from "./client/reply-model";
import { DirectorReplyCard } from "./client/reply-card";
import { readDirectorReplyPreview } from "./client/reply-preview";

export default function contribute(client: PluginClientContext) {
  const command = createDirectorCommand();
  const cleanupControls = installConversationControls(client, command.requests);
  client.addSettingsScreen({ id: "director-settings", title: "协作设置", icon: "Settings", Component: DirectorSurface });
  client.addTimelineRenderer({ kind: "director-chat-notice", version: 1, schema: ChatNoticeSchema, Component: ChatNotice });
  client.addTimelineTransformer({ id: "director-chat-notices", query: { itemType: "user_message" }, transform: ({ item }) => {
    const id = item.clientMessageId ?? item.messageId;
    return id?.startsWith("chat-notice:") && item.text.startsWith(`[paseo-director-chat:${id}]`)
      ? { items: [{ type: "plugin", kind: "director-chat-notice", version: 1, data: { raw: item.text } }] } : undefined;
  } });
  client.addCommandCenterItem({ id: "director-settings", title: "协作设置", icon: "Settings", context: "global", onSelect: () => client.openSettings("director-settings") });
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
  client.addWorkspacePanel({ id: "director", title: "新建协作对话", icon: "Workflow", context: "workspace", Component: props => <DirectorPanel {...props} requests={command.requests} /> });
  client.addCommandCenterItem({ id: "open-director", title: "新建协作对话", icon: "Workflow", context: "workspace", onSelect: context => command.submit({ ...context, args: "", fresh: true }) });
  client.addSlashCommand({ name: "director", description: "用原生主对话协作；留空打开当前协作对话", argumentHint: "任务描述", context: "workspace", onSubmit: command.submit });
  return () => { cleanupControls(); command.dispose(); };
}
