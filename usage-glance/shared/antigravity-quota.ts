import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const snapshotSchema = z.object({
  fetchedAt: z.string(),
  stale: z.boolean().optional(),
  refreshing: z.boolean().optional(),
  windows: z.array(z.object({
    id: z.string(), label: z.string(), shortLabel: z.string().optional(),
    usedPct: z.number(), remainingPct: z.number(), resetsAt: z.string().nullable(),
    tone: z.enum(['ok', 'warning', 'danger']),
  })),
});
export const readAntigravityQuota = defineRpc({
  name: 'read-antigravity-quota', input: z.object({}), output: snapshotSchema,
});
export type AntigravityQuotaSnapshot = z.infer<typeof snapshotSchema>;
