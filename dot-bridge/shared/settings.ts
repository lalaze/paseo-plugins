/**
 * Host settings for dot-bridge. The connection's display name and public tunnel base are **not**
 * here: the connection record (edited in the Connection tab) is the single source of truth for them,
 * so a settings reload can never overwrite a saved connection. Secrets (the MCP bearer token and the
 * callback signing secret) also live server-side, never in settings.
 */
import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const settingsSchema = z
  .object({
    /** Bridge's own in-flight cap. Not an OpenAI concurrency quota. */
    maxInFlightTasks: z.union([z.literal(1), z.literal(2)]).default(2),
    /** Where the plugin's MCP HTTP server binds. Prefer loopback plus a Secure MCP Tunnel. */
    listenHost: z.string().min(1).max(200).default('127.0.0.1'),
    listenPort: z.number().int().min(0).max(65535).default(0),
    /** Explicit host-user opt-in; never infer approval from installation or a tool call. */
    appendTaskAuthorization: z.boolean().default(false),
  })
  .strict();

export type DotBridgeSettings = z.infer<typeof settingsSchema>;

export const SETTINGS_ID = 'dot-bridge';

export const dotBridgeSettingsDefinition = defineSettings({
  id: SETTINGS_ID,
  scope: 'host',
  version: 4,
  schema: settingsSchema,
  /**
   * v1 stored `connectionName` and `publicBaseUrl` alongside the connection. They are now owned by
   * the connection record, so drop them on migration instead of leaving a second, conflicting copy.
   */
  migrate: values => {
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      const copy = { ...(values as Record<string, unknown>) };
      delete copy.connectionName;
      delete copy.publicBaseUrl;
      delete copy.defaultRepository;
      delete copy.defaultTargetBranch;
      delete copy.defaultEnvironmentHint;
      return copy;
    }
    return values;
  },
});

export const defaultSettings: DotBridgeSettings = settingsSchema.parse({});
