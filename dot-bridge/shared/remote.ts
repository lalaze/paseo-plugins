import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const remoteCapabilitiesSchema = z.object({ chat: z.boolean(), attachments: z.boolean(), readFiles: z.boolean(), writeFiles: z.boolean() }).strict();
export type RemoteCapabilities = z.infer<typeof remoteCapabilitiesSchema>;
export const remoteDeviceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(100), capabilities: remoteCapabilitiesSchema,
  tailscaleIp: z.string().optional(),
  workspaceIds: z.array(z.string().min(1).max(200)).max(100), revoked: z.boolean(), createdAt: z.number(),
}).strict();
export const remoteConfigSchema = z.object({
  mode: z.enum(['local', 'center', 'remote']).default('local'),
  host: z.string().min(1).max(200).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(47823),
  url: z.string().max(2000).default(''),
  transport: z.enum(['credential', 'tailscale']).default('credential'),
  privateHttp: z.boolean().default(false),
  readFiles: z.boolean().default(false), writeFiles: z.boolean().default(false),
  workspaceIds: z.array(z.string().min(1).max(200)).max(100).default([]),
}).strict();
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export const remoteStateSchema = z.object({
  config: remoteConfigSchema, devices: z.array(remoteDeviceSchema), connected: z.boolean(),
  tailscaleAddress: z.string().default(''),
  endpoint: z.string(), error: z.string().nullable(), tokenConfigured: z.boolean(),
}).strict();
export const remoteState = defineRpc({ name: 'remote-state', input: z.object({}).strict(), output: remoteStateSchema });
export const remoteConfigure = defineRpc({
  name: 'remote-configure',
  input: z.object({ config: remoteConfigSchema, token: z.string().max(1000).optional(), confirm: z.literal(true) }).strict(),
  output: remoteStateSchema,
});
export const remoteCreateDevice = defineRpc({
  name: 'remote-create-device', input: z.object({
    name: z.string().min(1).max(100), capabilities: remoteCapabilitiesSchema,
    workspaceIds: z.array(z.string().min(1).max(200)).min(1).max(100), confirm: z.literal(true),
  }).strict(),
  output: z.object({ device: remoteDeviceSchema, token: z.string() }).strict(),
});
export const remoteRevokeDevice = defineRpc({
  name: 'remote-revoke-device', input: z.object({ id: z.string().uuid(), confirm: z.literal(true) }).strict(),
  output: remoteStateSchema,
});
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>;
