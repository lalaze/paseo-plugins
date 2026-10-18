import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const pages = [
  "agents",
  "sessions",
  "library",
  "providers",
  "routing",
  "gateway",
  "usage",
  "plugins",
  "settings",
] as const;
export type Page = (typeof pages)[number];
const text = z.string().default("");
const count = z.number().default(0);
const flag = z.boolean().default(false);
const strings = z.array(z.string()).default([]);
export const choiceSchema = z.object({ value: z.string(), label: z.string(), note: text });
const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: text,
  options: z.array(choiceSchema).default([]),
});
export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: text,
  wired: flag,
  source: text,
  drift: flag,
  fields: z.array(fieldSchema).default([]),
});
export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  on: flag,
  context: count,
  images: flag,
  efforts: strings,
});
const keySchema = z.object({ id: z.string(), name: text, masked: text, on: flag, active: flag });
const loginSchema = z.object({
  agent: text,
  user: text,
  plan: text,
  on: flag,
  active: flag,
  lapsed: text,
});
export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  preset: text,
  host: text,
  chat: text,
  responses: text,
  anthropic: text,
  gemini: text,
  baseAPI: text,
  ready: flag,
  off: flag,
  keyMasked: text,
  exposed: count,
  routing: text,
  chosen: strings,
  noModels: flag,
  listError: text,
  fetched: text,
  accountAgent: text,
  models: z.array(modelSchema).default([]),
  keys: z.array(keySchema).default([]),
  logins: z.array(loginSchema).default([]),
});
export const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: text,
  chat: text,
  responses: text,
  anthropic: text,
  gemini: text,
  added: flag,
});
export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  routing: text,
  members: strings,
  match: strings,
  off: strings,
  disabled: flag,
  ready: flag,
  auto: flag,
});
export const callSchema = z.object({
  id: count,
  time: text,
  agent: text,
  model: text,
  provider: text,
  status: count,
  ms: count,
  error: text,
  input: count,
  output: count,
});
export const gatewaySchema = z.object({
  url: text,
  running: flag,
  models: count,
  mine: flag,
  calls: z.array(callSchema).default([]),
});
const usageRowSchema = z.object({
  name: text,
  label: text,
  id: text,
  calls: count,
  errors: count,
  input: count,
  output: count,
  cache_read: count,
  cache_write: count,
  cost: count,
});
export const usageSchema = usageRowSchema.extend({
  series: z.array(usageRowSchema).default([]),
  agents: z.array(usageRowSchema).default([]),
  models: z.array(usageRowSchema).default([]),
});
export const quotaSchema = z.object({
  provider: text,
  name: text,
  user: text,
  plan: text,
  balance: text,
  error: text,
  windows: z
    .array(
      z.object({
        name: text,
        used: count,
        remaining: count,
        resetsAt: text,
        unlimited: flag,
        display: text,
      }),
    )
    .default([]),
});
export const sessionSchema = z.object({
  agent: z.string(),
  id: z.string(),
  name: text,
  title: text,
  cwd: text,
  last: text,
  input: count,
  output: count,
  cost: count,
  resume: text,
  transcript: flag,
});
export const builtinSchema = z.object({
  id: z.string(),
  name: text,
  sub: text,
  on: flag,
  inUse: count,
  why: text,
});
export const pluginSchema = z.object({
  spec: z.string(),
  name: text,
  version: text,
  off: flag,
  error: text,
  providers: strings,
});
export const pluginCatalogItemSchema = z.object({
  spec: z.string().min(1),
  name: text,
  description: text,
  kind: text,
  community: flag,
  source: z.enum(["suggested", "github", "npm"]),
  version: text,
  publisher: text,
  repository: text,
  providers: strings,
  weekly: count,
});
export type PluginCatalogItem = z.infer<typeof pluginCatalogItemSchema>;
export const readPluginCatalog = defineRpc({
  name: "magpie.plugins.catalog",
  input: z.object({
    source: z.enum(["suggested", "github", "npm"]),
    query: z.string().max(200).default(""),
  }),
  output: z.object({ items: z.array(pluginCatalogItemSchema) }),
});
export const settingsSchema = z.object({
  theme: text,
  lang: text,
  currency: text,
  proxy: text,
  textSize: count,
  version: text,
  dir: text,
  gateway: text,
});
const libraryItemSchema = z.object({
  name: z.string(),
  description: text,
  transport: text,
  command: text,
  url: text,
  agents: strings,
  source: text,
});
export const librarySchema = z.object({
  dir: text,
  servers: z.array(libraryItemSchema).default([]),
  skills: z.array(libraryItemSchema).default([]),
  agents: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});

export const pageDataSchema = z.object({
  page: z.enum(pages),
  notices: strings,
  agents: z.array(agentSchema).default([]),
  profiles: z.array(z.object({ name: z.string(), summary: text, inUse: flag })).default([]),
  providers: z.array(providerSchema).default([]),
  presets: z.array(presetSchema).default([]),
  groups: z.array(groupSchema).default([]),
  models: z.array(choiceSchema).default([]),
  gateway: gatewaySchema.nullable().default(null),
  usage: usageSchema.nullable().default(null),
  quotas: z.array(quotaSchema).default([]),
  sessions: z.array(sessionSchema).default([]),
  total: count,
  library: librarySchema.nullable().default(null),
  plugins: z.array(pluginSchema).default([]),
  builtins: z.array(builtinSchema).default([]),
  settings: settingsSchema.nullable().default(null),
});
export const readPage = defineRpc({
  name: "magpie.page.read",
  input: z.object({
    page: z.enum(pages),
    period: z.enum(["today", "7d", "30d", "all"]).default("today"),
    query: text,
    limit: z.number().int().min(20).max(2000).default(100),
    quotas: flag,
  }),
  output: pageDataSchema,
});

const id = z.string().min(1).max(500);
export const providerDraftSchema = z.object({
  id: text,
  name: z.string().min(1),
  preset: text,
  chat: text,
  responses: text,
  anthropic: text,
  gemini: text,
  baseAPI: text,
  key: text,
  models: strings,
  noModels: flag,
});
export const groupDraftSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9.-]*$/),
  name: z.string().min(1),
  members: z.array(z.string()).min(1),
  routing: z.string().min(1).max(500),
});
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.set"), id, field: id, value: z.string() }),
  z.object({ type: z.literal("agent.connect"), id }),
  z.object({ type: z.literal("agent.disconnect"), id }),
  z.object({ type: z.literal("agent.reapply"), id }),
  z.object({ type: z.literal("agents.rescan") }),
  z.object({
    type: z.literal("profile"),
    operation: z.enum(["save", "apply", "delete"]),
    name: id,
  }),
  z.object({ type: z.literal("provider.save"), draft: providerDraftSchema, fresh: z.boolean() }),
  z.object({ type: z.literal("provider.toggle"), id, on: z.boolean() }),
  z.object({ type: z.literal("provider.delete"), id }),
  z.object({ type: z.literal("provider.fetch"), id }),
  z.object({ type: z.literal("key.add"), id, name: text, key: z.string().min(1) }),
  z.object({
    type: z.literal("key.change"),
    id,
    ref: id,
    operation: z.enum(["on", "off", "use", "remove"]),
  }),
  z.object({
    type: z.literal("login.change"),
    id,
    user: id,
    operation: z.enum(["on", "off", "use", "remove"]),
  }),
  z.object({ type: z.literal("group.save"), draft: groupDraftSchema }),
  z.object({ type: z.literal("group.delete"), id }),
  z.object({ type: z.literal("group.toggle"), id, on: z.boolean() }),
  z.object({ type: z.literal("plugin.add"), spec: id }),
  z.object({ type: z.literal("plugin.toggle"), spec: id, on: z.boolean() }),
  z.object({ type: z.literal("plugin.remove"), spec: id }),
  z.object({ type: z.literal("plugin.upgrade"), spec: id }),
  z.object({ type: z.literal("builtin.toggle"), id, on: z.boolean() }),
  z.object({
    type: z.literal("settings.save"),
    settings: settingsSchema
      .pick({
        theme: true,
        lang: true,
        currency: true,
        proxy: true,
        textSize: true,
      })
      .extend({ textSize: z.number().int().min(0).max(30) }),
  }),
  z.object({
    type: z.literal("library.server.save"),
    old: text,
    name: id,
    transport: z.enum(["http", "sse", "stdio"]),
    url: text,
    command: text,
    args: strings,
    agents: strings,
  }),
  z.object({
    type: z.literal("library.distribute"),
    kind: z.enum(["servers", "skills"]),
    name: id,
    agents: strings,
  }),
  z.object({ type: z.literal("library.remove"), kind: z.enum(["servers", "skills"]), name: id }),
  z.object({ type: z.literal("library.skill.install"), source: id, agents: strings }),
]);
export const runAction = defineRpc({
  name: "magpie.action.run",
  input: actionSchema,
  output: z.object({ notice: text, jobId: text }),
});
export const jobSchema = z.object({
  state: z.enum(["running", "done", "failed"]),
  notice: text,
  error: text,
});
export const readJob = defineRpc({
  name: "magpie.job.read",
  input: z.object({ id }),
  output: jobSchema,
});
export const signInSchema = z.object({
  id: text,
  agent: text,
  url: text,
  code: text,
  state: text,
  instructions: text,
  error: text,
  pasteCallback: flag,
});
export const signIn = defineRpc({
  name: "magpie.signin",
  input: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("start"), agent: id }),
    z.object({ operation: z.literal("status"), id }),
    z.object({ operation: z.literal("cancel"), id }),
    z.object({ operation: z.literal("callback"), id, url: z.string().min(1).max(16384) }),
  ]),
  output: signInSchema,
});
export const readTranscript = defineRpc({
  name: "magpie.transcript.read",
  input: z.object({ agent: id, id }),
  output: z.object({
    parts: z.array(z.object({ role: text, kind: text, name: text, text: z.string(), model: text })),
    cut: flag,
  }),
});
export type PageData = z.infer<typeof pageDataSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ProviderDraft = z.infer<typeof providerDraftSchema>;
export type GroupDraft = z.infer<typeof groupDraftSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Choice = z.infer<typeof choiceSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type SignIn = z.infer<typeof signInSchema>;
