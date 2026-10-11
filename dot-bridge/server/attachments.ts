import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentContentSchema, MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentContent } from '../shared/attachments';
import { dotBridgeError } from '../shared/errors';

export function decodeAttachment(input: AttachmentContent): Buffer {
  attachmentContentSchema.parse({ name: input.name, mediaType: input.mediaType, encoding: input.encoding, content: input.content });
  if (input.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) {
    throw dotBridgeError('attachment-invalid', 'noncanonical base64');
  }
  const bytes = Buffer.from(input.content, input.encoding === 'utf8' ? 'utf8' : 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw dotBridgeError('attachment-too-large');
  if (input.encoding === 'base64' && bytes.toString('base64') !== input.content) throw dotBridgeError('attachment-invalid');
  return bytes;
}

/** Blobs are private, content-addressed and immutable. Only task metadata grants access. */
export class AttachmentStore {
  private readonly root: string;
  constructor(dataDir: string) { this.root = join(dataDir, 'attachments'); }

  async put(bytes: Buffer): Promise<string> {
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw dotBridgeError('attachment-too-large');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.root, hash));
    } finally { await unlink(temporary).catch(() => undefined); }
    return hash;
  }

  async get(attachment: Attachment): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) throw dotBridgeError('attachment-invalid');
    const bytes = await readFile(join(this.root, attachment.sha256));
    if (bytes.length !== attachment.size || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) {
      throw dotBridgeError('attachment-invalid', 'stored file failed integrity check');
    }
    return bytes;
  }
}
