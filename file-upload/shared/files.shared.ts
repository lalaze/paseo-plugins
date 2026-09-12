import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const CHUNK_SIZE = 192 * 1024;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
const target = { workspaceId: z.string().min(1), path: z.string().max(4096) };
export const entrySchema = z.object({ name: z.string(), path: z.string(), directory: z.boolean(), size: z.number() });
export type Entry = z.infer<typeof entrySchema>;
export const listFiles = defineRpc({ name: 'list-files', input: z.object(target), output: z.array(entrySchema) });
export const startUpload = defineRpc({ name: 'start-upload', input: z.object({ ...target, size: z.number().int().min(0).max(MAX_FILE_SIZE) }), output: z.object({ id: z.string() }) });
export const uploadChunk = defineRpc({ name: 'upload-chunk', input: z.object({ id: z.string(), offset: z.number().int().nonnegative(), data: z.string().max(CHUNK_SIZE / 3 * 4) }), output: z.object({ offset: z.number() }) });
export const finishUpload = defineRpc({ name: 'finish-upload', input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) });
export const cancelUpload = defineRpc({ name: 'cancel-upload', input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) });
export const downloadChunk = defineRpc({ name: 'download-chunk', input: z.object({ ...target, offset: z.number().int().nonnegative(), version: z.string().optional() }), output: z.object({ data: z.string(), size: z.number(), version: z.string(), nextOffset: z.number() }) });
