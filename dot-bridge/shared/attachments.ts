import { z } from 'zod';

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Divisible by three: separately encoded chunks can also form a single data URI.
export const ATTACHMENT_CHUNK_BYTES = 384 * 1024;
// Per-request and in-flight bounds are independent of the retained attachment archive.
export const MAX_PROMPT_ATTACHMENTS = 16;
export const MAX_PENDING_TRANSFERS = 16;
export const ATTACHMENT_PAGE_SIZE = 8;
export const MAX_ATTACHMENT_CONTENT = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const attachmentIdSchema = z.string().uuid();
export const attachmentNameSchema = z.string().min(1).max(160)
  .refine(name => name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name), 'Use a file name without path separators');
export const attachmentContentSchema = z.object({
  name: attachmentNameSchema,
  mediaType: z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/).max(120).default('application/octet-stream'),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string().max(MAX_ATTACHMENT_CONTENT),
}).strict();
export const attachmentSchema = z.object({
  id: attachmentIdSchema,
  roundId: z.string().uuid(),
  name: attachmentNameSchema,
  mediaType: z.string().max(120),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  author: z.enum(['user', 'dot']),
  createdAt: z.number().int().nonnegative(),
  localPath: z.string().max(4000).optional(),
}).strict();
export const attachmentChunkSchema = z.object({
  name: attachmentNameSchema,
  mediaType: attachmentContentSchema.shape.mediaType,
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  index: z.number().int().min(0).max(Math.ceil(MAX_FILE_BYTES / ATTACHMENT_CHUNK_BYTES) - 1),
  content: z.string().max(ATTACHMENT_CHUNK_BYTES / 3 * 4),
}).strict();
export type AttachmentChunk = z.infer<typeof attachmentChunkSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type AttachmentContent = z.infer<typeof attachmentContentSchema>;
