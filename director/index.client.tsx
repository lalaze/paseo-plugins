import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ChatNotice, ChatNoticeSchema } from "./client/chat-notice";
import { installConversationControls } from "./client/conversation-controls";
import { DirectorSurface } from "./client/main";
import { createDirectorCommand } from "./client/launch";
import { readDirectorPrompt, PromptCardSchema } from "./client/prompt-model";
import { DirectorPromptCard } from "./client/prompt-card";
import { readDirectorReply, ReplyCardSchema } from "./client/reply-model";
import { DirectorReplyCard } from "./client/reply-card";
import { readDirectorReplyPreview } from "./client/reply-preview";

export default function contribute(client: PluginClientContext) {
  const command = createDirectorCommand();
  const cleanupControls = installConversationControls(client);
  const Settings = (props: Parameters<typeof DirectorSurface>[0]) => <DirectorSurface {...props} onConfigured={command.resumeSetup} />;
  client.addSettingsScreen({ id: "director-settings", title: "协作设置", icon: "Settings", Component: Settings });
  client.addTimelineRenderer({ kind: "director-chat-notice", version: 1, schema: ChatNoticeSchema, Component: ChatNotice });
  client.addTimelineTransformer({ id: "director-chat-notices", query: { itemType: "user_message" }, transform: ({ item }) => {
    const id = item.clientMessageId ?? item.messageId;
    return id?.startsWith("chat-notice:") && item.text.startsWith(`[paseo-director-chat:${id}]`)
      ? { items: [{ type: "plugin", kind: "director-chat-notice", version: 1, data: { raw: item.text } }] } : undefined;
  } });
  client.addTimelineTransformer({ id: "director-takeover-messages", query: { itemType: "user_message" }, transform: ({ item }) => {
    const id = item.clientMessageId ?? item.messageId;
    const boundary = item.text.indexOf("\n\n[paseo-director-takeover]\n");
    if (!id?.startsWith("chat-command:") || boundary < 0) return;
    const text = item.text.slice(0, boundary);
    return { items: [{ type: "plugin", kind: "director-chat-notice", version: 1, data: { raw: item.text, title: "协作请求", summary: text.startsWith("用户已在当前对话启用协作。") ? "在当前对话启用协作" : text } }] };
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
  client.addSurface("director", Settings);
  client.addCommandCenterItem({ id: "open-director", title: "新建协作对话", icon: "Workflow", context: "workspace", onSelect: context => command.submit({ ...context, args: "", fresh: true }) });
  client.addCommandCenterItem({ id: "takeover-director", title: "在当前对话启用协作", icon: "Workflow", context: "agent", onSelect: context => command.submit({ ...context, args: "" }) });
  client.addSlashCommand({ name: "director", description: "在当前对话启用协作，保留模型和聊天记录", argumentHint: "任务描述（可选）", context: "agent", onSubmit: command.submit });
  return () => { cleanupControls(); command.dispose(); };
}
