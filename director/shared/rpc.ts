import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SettingsSchema } from "./schema";
import { DraftStateSchema } from "./settings-draft";

export const getSettingsRpc = defineRpc({ name: "director.settings.get", input: z.object({}), output: z.object({ settings: SettingsSchema.nullable(), error: z.string().nullable() }) });
export const getSettingsDraftRpc = defineRpc({ name: "director.settings.draft.get", input: z.object({}), output: DraftStateSchema });
export const writeSettingsDraftRpc = defineRpc({ name: "director.settings.draft.write", input: DraftStateSchema, output: DraftStateSchema });
export const commitSettingsRpc = defineRpc({ name: "director.settings.commit", input: z.object({ settings: SettingsSchema, base: SettingsSchema.nullable(), draftRevision: z.number().int().nonnegative() }), output: z.object({ saved: z.boolean(), draft: DraftStateSchema }) });

export const openConversationRpc = defineRpc({ name: "director.conversation.open", input: z.object({ requestId: z.string().min(1).max(200), workspaceId: z.string().min(1), goal: z.string().trim().max(32000).optional(), fresh: z.boolean().optional(), agentId: z.string().min(1).optional(), conversationId: z.string().optional() }), output: z.custom<import("./conversation").ConversationSummary>() });
export const getConversationRpc = defineRpc({ name: "director.conversation.get", input: z.object({ id: z.string() }), output: z.custom<import("./conversation").ConversationSummary>() });
export const resyncConversationRpc = defineRpc({ name: "director.conversation.resync", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) });
