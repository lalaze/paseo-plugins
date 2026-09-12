import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

/** null keeps the header on the lowest remaining available quota. */
export const headerSettings = defineSettings({
  id: 'header',
  scope: 'host',
  version: 1,
  schema: z.object({
    providerId: z.string().min(1).max(80).nullable().default(null),
  }),
});
