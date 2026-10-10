import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * Multi-machine sharing. One host (the center) runs an HTTP MCP gateway; other hosts hold a
 * revocable device credential and reach the center's MCP servers through it. The center keeps
 * the upstream authorization; a device only ever sees its own token and the server catalog.
 */

/** The center binds every interface once the gateway is switched on; it is off by default. */
export const DEFAULT_GATEWAY_HOST = '0.0.0.0';
/** Away from the OAuth callback port (47821). */
export const DEFAULT_GATEWAY_PORT = 47822;
/** The user-visible address of this machine on the private network. */
export const DEFAULT_PUBLIC_HOST = '100.96.195.115';

export function defaultPublicUrl(port: number): string {
  return `http://${DEFAULT_PUBLIC_HOST}:${port}`;
}

export const gatewayConfigSchema = z.object({
  enabled: z.boolean(),
  /** The address the gateway binds. `0.0.0.0` makes it reachable from other machines. */
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** The address other machines use; empty falls back to the default for the port. */
  publicUrl: z.string().trim().max(2048),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/** A device credential's public row. The token itself is never returned after creation. */
export const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The providers this credential is authorized for; it cannot be used as any other provider. */
  providers: z.array(z.string()).min(1),
  /** Null allows every server the allowed providers may use; an empty list allows none. */
  servers: z.array(z.string()).nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

export const catalogServerSchema = z.object({ name: z.string(), path: z.string() });
export type CatalogServer = z.infer<typeof catalogServerSchema>;

export const remoteStatuses = ['unknown', 'ok', 'error'] as const;
export type RemoteStatus = (typeof remoteStatuses)[number];

/** A connection from this host to a center gateway. */
export const remoteSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  /** The provider the center fixed this device credential to. */
  provider: z.string(),
  createdAt: z.string(),
  checkedAt: z.string().nullable(),
  status: z.enum(remoteStatuses),
  error: z.string().nullable(),
  catalog: z.array(catalogServerSchema),
});
export type Remote = z.infer<typeof remoteSchema>;

export const gatewayStateSchema = z.object({
  dataDir: z.string(),
  config: gatewayConfigSchema,
  running: z.boolean(),
  runningSince: z.string().nullable(),
  error: z.string().nullable(),
  /** Addresses this gateway can be reached at, for copying into a device connection. */
  localUrls: z.array(z.string()),
  devices: z.array(deviceSchema),
  remotes: z.array(remoteSchema),
  /** Local servers that can be shared over the gateway (enabled HTTP servers). */
  shareable: z.array(z.string()),
  notes: z.array(z.string()),
});
export type GatewayState = z.infer<typeof gatewayStateSchema>;

export const readGatewayState = defineRpc({ name: 'read-gateway-state', input: z.object({}), output: gatewayStateSchema });

export const saveGatewayConfig = defineRpc({
  name: 'save-gateway-config',
  input: gatewayConfigSchema,
  output: gatewayStateSchema,
});

/** Creates a device credential; the token is returned once and only its hash is kept. */
export const createDevice = defineRpc({
  name: 'create-device',
  input: z.object({
    name: z.string().trim().min(1).max(64),
    /** The legacy single-provider form; still accepted. */
    provider: z.string().min(1).optional(),
    /** One or more providers this credential may be used as; the preferred form. */
    providers: z.array(z.string().min(1)).optional(),
    servers: z.array(z.string()).nullable(),
  }),
  output: z.object({ state: gatewayStateSchema, token: z.string() }),
});

/** Changes which providers a device credential is authorized for, keeping the same token. */
export const updateDeviceProviders = defineRpc({
  name: 'update-device-providers',
  input: z.object({ id: z.string(), providers: z.array(z.string().min(1)).min(1) }),
  output: gatewayStateSchema,
});

export const revokeDevice = defineRpc({
  name: 'revoke-device',
  input: z.object({ id: z.string() }),
  output: gatewayStateSchema,
});

/** Removes a revoked device credential for good. Only revoked devices may be deleted. */
export const deleteDevice = defineRpc({
  name: 'delete-device',
  input: z.object({ id: z.string() }),
  output: gatewayStateSchema,
});

/** Saves a center connection on this host and checks it right away, one row per provider. */
export const connectRemote = defineRpc({
  name: 'connect-remote',
  input: z.object({
    name: z.string().trim().min(1).max(64),
    url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096),
    /** The legacy single-provider form; still accepted. */
    provider: z.string().min(1).optional(),
    /** One or more providers to connect with the same token; the preferred form. */
    providers: z.array(z.string().min(1)).optional(),
  }),
  output: gatewayStateSchema,
});

export const refreshRemote = defineRpc({ name: 'refresh-remote', input: z.object({ id: z.string() }), output: gatewayStateSchema });

export const disconnectRemote = defineRpc({ name: 'disconnect-remote', input: z.object({ id: z.string() }), output: gatewayStateSchema });
