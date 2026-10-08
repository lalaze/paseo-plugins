import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const headers = z.record(z.string(), z.string()).optional();

/** Paseo's provider-neutral MCP shape; the daemon translates it for each provider. */
export const mcpConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), alwaysLoad: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('http'), url: z.string().min(1), headers, alwaysLoad: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('sse'), url: z.string().min(1), headers, alwaysLoad: z.boolean().optional() }).strict(),
]);
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** Letters, digits, `_` and `-`: every provider accepts these as a server or skill name. */
export const nameSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const mcpServerSchema = z.object({
  name: nameSchema,
  enabled: z.boolean(),
  /** Null shares the server with every provider that has MCP switched on. */
  providers: z.array(z.string()).nullable(),
  config: mcpConfigSchema,
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** False when Paseo no longer lists it as enabled; its saved choices are kept. */
  present: z.boolean(),
  mcp: z.boolean(),
  /** Why MCP is off by default for this provider, if it is. */
  mcpNote: z.string().nullable(),
  skills: z.boolean(),
  /** Where the copies go; null when the plugin does not know this CLI and no folder is set. */
  skillsDir: z.string().nullable(),
  skillsDirCustom: z.boolean(),
});
export type ProviderRow = z.infer<typeof providerSchema>;

export const targetStatuses = ['synced', 'modified', 'conflict', 'error'] as const;
export type TargetStatus = (typeof targetStatuses)[number];

export const skillSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  targets: z.array(z.object({ provider: z.string(), status: z.enum(targetStatuses), message: z.string().nullable() })),
});
export type SkillRow = z.infer<typeof skillSchema>;

export const foundSkillSchema = z.object({ name: z.string(), provider: z.string(), path: z.string(), description: z.string().nullable() });
export type FoundSkill = z.infer<typeof foundSkillSchema>;

/** A server the plugin holds an OAuth sign-in for. `expiresAt` is set only when the token cannot be refreshed. */
export const authSchema = z.object({ status: z.enum(['signed-in', 'expired']), expiresAt: z.string().nullable(), scope: z.string().nullable() });
export type AuthRow = z.infer<typeof authSchema>;

export const stateSchema = z.object({
  dataDir: z.string(),
  libraryDir: z.string(),
  providers: z.array(providerSchema),
  mcpServers: z.array(mcpServerSchema),
  /** By server name; servers without a sign-in are absent. */
  auth: z.record(z.string(), authSchema),
  skills: z.array(skillSchema),
  /** Skills in a provider's folder that the library does not have yet. */
  found: z.array(foundSkillSchema),
  syncedAt: z.string().nullable(),
  /** Problems from the last sync that do not belong to one skill. */
  notes: z.array(z.string()),
});
export type SharedState = z.infer<typeof stateSchema>;

export const readState = defineRpc({ name: 'read-state', input: z.object({}), output: stateSchema });

export const saveMcpServer = defineRpc({
  name: 'save-mcp-server',
  input: mcpServerSchema.extend({ previousName: z.string().nullable() }),
  output: stateSchema,
});

export const deleteMcpServer = defineRpc({ name: 'delete-mcp-server', input: z.object({ name: z.string() }), output: stateSchema });

export const mcpImportSources = ['claude', 'codex', 'json'] as const;
export const importMcpServers = defineRpc({
  name: 'import-mcp-servers',
  input: z.object({ source: z.enum(mcpImportSources), json: z.string().max(200_000).optional(), replace: z.boolean().default(false) }),
  output: z.object({ state: stateSchema, imported: z.array(z.string()), skipped: z.array(z.string()) }),
});

export const updateProvider = defineRpc({
  name: 'update-provider',
  input: z.object({
    provider: z.string().min(1),
    mcp: z.boolean().optional(),
    skills: z.boolean().optional(),
    /** An empty string goes back to the folder the plugin knows for this CLI. */
    skillsDir: z.string().max(1024).optional(),
  }),
  output: stateSchema,
});

export const importSkill = defineRpc({
  name: 'import-skill',
  input: z.object({ path: z.string().min(1).max(1024), replace: z.boolean().default(false) }),
  output: stateSchema,
});

export const deleteSkill = defineRpc({ name: 'delete-skill', input: z.object({ name: z.string() }), output: stateSchema });

/** Replaces one provider's copy with the library's; the copy it replaces is moved to the backup folder. */
export const overwriteSkill = defineRpc({
  name: 'overwrite-skill',
  input: z.object({ name: z.string(), provider: z.string() }),
  output: stateSchema,
});

export const syncSkills = defineRpc({ name: 'sync-skills', input: z.object({}), output: stateSchema });

/** Starts an OAuth sign-in; the app opens `authorizationUrl` in this device's browser. */
export const startSignIn = defineRpc({
  name: 'start-sign-in',
  input: z.object({ name: z.string() }),
  output: z.object({
    authorizationUrl: z.string(),
    redirectUri: z.string(),
    /** False when the callback port on the host is taken, so only pasting the address finishes it. */
    listening: z.boolean(),
  }),
});

/** Finishes a sign-in with the address the browser ended on (or just its code). */
export const finishSignIn = defineRpc({
  name: 'finish-sign-in',
  input: z.object({ name: z.string(), callback: z.string().max(8192) }),
  output: stateSchema,
});

export const signInStatus = defineRpc({
  name: 'sign-in-status',
  input: z.object({ name: z.string() }),
  output: z.object({ status: z.enum(['none', 'pending', 'done', 'failed']), error: z.string().nullable() }),
});

/** Cancels a pending sign-in and forgets the stored tokens. */
export const signOut = defineRpc({ name: 'sign-out', input: z.object({ name: z.string() }), output: stateSchema });

/** Drops a pending sign-in and keeps any tokens from an earlier one. */
export const cancelSignIn = defineRpc({ name: 'cancel-sign-in', input: z.object({ name: z.string() }), output: z.object({}) });
