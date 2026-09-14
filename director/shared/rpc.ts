import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SettingsSchema, type Run, type RunSummary } from "./schema";
import { DraftStateSchema } from "./settings-draft";

export const getSettingsRpc = defineRpc({ name: "director.settings.get", input: z.object({}), output: z.object({ settings: SettingsSchema.nullable(), error: z.string().nullable() }) });
export const saveSettingsRpc = defineRpc({ name: "director.settings.save", input: SettingsSchema, output: z.object({ saved: z.boolean() }) });
export const getSettingsDraftRpc = defineRpc({ name: "director.settings.draft.get", input: z.object({}), output: DraftStateSchema });
export const writeSettingsDraftRpc = defineRpc({ name: "director.settings.draft.write", input: DraftStateSchema, output: DraftStateSchema });
export const commitSettingsRpc = defineRpc({ name: "director.settings.commit", input: z.object({ settings: SettingsSchema, base: SettingsSchema.nullable(), draftRevision: z.number().int().nonnegative() }), output: z.object({ saved: z.boolean() }) });
export const createRunRpc = defineRpc({ name: "director.run.create", input: z.object({ requestId: z.string().min(1).max(120), repository: z.string().min(1), goal: z.string().min(1).max(32000), workspaceId: z.string().min(1).max(200).optional(), settings: SettingsSchema.optional() }), output: z.object({ id: z.string() }) });
export const listRunsRpc = defineRpc({ name: "director.run.list", input: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }), output: z.object({ runs: z.custom<RunSummary[]>(), hasMore: z.boolean(), error: z.string().nullable() }) });
export const getRunRpc = defineRpc({ name: "director.run.get", input: z.object({ id: z.string() }), output: z.custom<Run>() });
export const getWorkspaceRunRpc = defineRpc({ name: "director.workspace.run", input: z.object({ workspaceId: z.string().min(1).max(200) }), output: z.object({ id: z.string().nullable() }) });
export const controlRunRpc = defineRpc({ name: "director.run.control", input: z.object({ id: z.string(), action: z.enum(["pause", "resume", "cancel", "retry", "approve_plan", "revise", "accept_final", "reject_final", "request_changes"]), goal: z.string().trim().min(1).max(32000).optional(), feedback: z.string().trim().min(1).max(16000).optional(), artifactId: z.string().min(1).optional(), expectedRevision: z.number().int().nonnegative().optional() }), output: z.object({ ok: z.boolean() }) });

export const openConversationRpc = defineRpc({ name: "director.conversation.open", input: z.object({ requestId: z.string().min(1).max(200), workspaceId: z.string().min(1), goal: z.string().trim().max(32000).optional(), fresh: z.boolean().optional(), conversationId: z.string().optional() }), output: z.custom<import("./conversation").ConversationSummary>() });
export const getConversationRpc = defineRpc({ name: "director.conversation.get", input: z.object({ id: z.string() }), output: z.custom<import("./conversation").ConversationSummary>() });
export const listConversationsRpc = defineRpc({ name: "director.conversation.list", input: z.object({ workspaceId: z.string().optional() }), output: z.array(z.custom<import("./conversation").ConversationListItem>()) });

export const resyncConversationRpc = defineRpc({ name: "director.conversation.resync", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) });
