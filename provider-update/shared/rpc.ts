import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const installKinds = ['claude-native', 'codex-standalone', 'npm', 'homebrew', 'homebrew-cask', 'unknown'] as const;
export type InstallKind = (typeof installKinds)[number];

export const providerUpdateSchema = z.object({
  provider: z.string(),
  label: z.string(),
  /** The executable the daemon launches, after following symlinks. */
  binary: z.string().nullable(),
  install: z.enum(installKinds),
  current: z.string().nullable(),
  /** Null when the install method has no version feed or the lookup failed. */
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  canUpdate: z.boolean(),
  state: z.enum(['idle', 'updating', 'updated', 'failed']),
  /** Tail of the last update's output, or why the provider could not be inspected. */
  message: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

export const listProviderUpdates = defineRpc({
  name: 'list-provider-updates',
  input: z.object({ refresh: z.boolean().default(false) }),
  output: z.object({ checkedAt: z.string(), providers: z.array(providerUpdateSchema) }),
});

export const updateProvider = defineRpc({
  name: 'update-provider',
  input: z.object({ provider: z.string().min(1).max(80) }),
  output: providerUpdateSchema,
});
