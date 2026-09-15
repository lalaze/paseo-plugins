import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const hostIdentitySchema = z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(200) });
export type HostIdentity = z.infer<typeof hostIdentitySchema>;
export const readHostIdentity = defineRpc({ name: 'read-host-identity', input: z.object({}), output: z.object({ id: z.string().min(1).max(200).nullable(), label: z.string().min(1).max(200) }) });
