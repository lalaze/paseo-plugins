import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ATTACHMENT_CHUNK_BYTES, attachmentChunkSchema, attachmentNameSchema, MAX_TASK_ATTACHMENTS, type AttachmentChunk } from '../shared/attachments';
import { dotBridgeError } from '../shared/errors';

type Transfer = AttachmentChunk & { taskId: string; roundId: string; connectionId: string; operationId: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = z.string().uuid();

function directory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw dotBridgeError('attachment-invalid', 'unsafe storage directory');
}

function read(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw dotBridgeError('attachment-invalid', 'unsafe storage file');
  return readFileSync(path);
}

function durable(path: string, bytes: Buffer | string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function decodeChunk(input: AttachmentChunk): Buffer {
  attachmentChunkSchema.parse({ name: input.name, mediaType: input.mediaType, size: input.size, sha256: input.sha256, index: input.index, content: input.content });
  const count = Math.ceil(input.size / ATTACHMENT_CHUNK_BYTES);
  const expected = Math.min(ATTACHMENT_CHUNK_BYTES, input.size - input.index * ATTACHMENT_CHUNK_BYTES);
  const bytes = Buffer.from(input.content, 'base64');
  if (input.index >= count || bytes.length !== expected || bytes.toString('base64') !== input.content) throw dotBridgeError('attachment-invalid', 'invalid chunk length or base64');
  return bytes;
}

/** Private resumable transfers. No attachment is published before the whole-file hash matches. */
export function receiveChunk(dataDir: string, input: Transfer, now: number): { received: number[]; bytes?: Buffer } {
  uuid.parse(input.taskId); uuid.parse(input.roundId); uuid.parse(input.operationId);
  const bytes = decodeChunk(input);
  const root = join(dataDir, 'transfers'); directory(root);
  const taskDir = join(root, input.taskId); directory(taskDir);
  // Bound abandoned uploads, and allow interrupted transfers to resume for 24 hours.
  for (const entry of readdirSync(taskDir)) {
    if (!uuid.safeParse(entry).success) continue;
    const path = join(taskDir, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) rmSync(path, { recursive: true });
  }
  const dir = join(taskDir, input.operationId);
  if (!existsSync(dir) && readdirSync(taskDir).length >= MAX_TASK_ATTACHMENTS) throw dotBridgeError('attachment-limit');
  directory(dir);
  const manifest = JSON.stringify({ taskId: input.taskId, roundId: input.roundId, connectionId: input.connectionId, operationId: input.operationId, name: input.name, mediaType: input.mediaType, size: input.size, sha256: input.sha256 });
  const metadata = join(dir, 'manifest.json');
  if (existsSync(metadata)) {
    if (read(metadata).toString('utf8') !== manifest) throw dotBridgeError('duplicate-mismatch', 'upload manifest');
  } else durable(metadata, manifest);
  const part = join(dir, `${input.index}.part`);
  if (existsSync(part)) {
    if (!read(part).equals(bytes)) throw dotBridgeError('duplicate-mismatch', 'upload chunk');
  } else durable(part, bytes);
  const count = Math.ceil(input.size / ATTACHMENT_CHUNK_BYTES);
  const received = Array.from({ length: count }, (_, i) => i).filter(i => existsSync(join(dir, `${i}.part`)));
  if (received.length !== count) return { received };
  const assembled = Buffer.concat(received.map(i => read(join(dir, `${i}.part`))));
  if (assembled.length !== input.size || hash(assembled) !== input.sha256) throw dotBridgeError('attachment-invalid', 'whole-file hash mismatch; restart with a new operationId');
  return { received, bytes: assembled };
}

export function clearTransfer(dataDir: string, taskId: string, operationId: string): void {
  uuid.parse(taskId); uuid.parse(operationId);
  rmSync(join(dataDir, 'transfers', taskId, operationId), { recursive: true, force: true });
}

/** Save delivered files with their actual name outside the project; never replace a user edit. */
export function saveDeliveredFile(dataDir: string, taskId: string, operationId: string, name: string, bytes: Buffer): string {
  uuid.parse(taskId); uuid.parse(operationId); attachmentNameSchema.parse(name);
  let dir = dataDir;
  for (const segment of ['files', taskId, operationId]) { dir = join(dir, segment); directory(dir); }
  const path = join(dir, name);
  if (existsSync(path)) {
    if (!read(path).equals(bytes)) throw dotBridgeError('attachment-invalid', 'saved file was edited; refusing to overwrite');
  } else durable(path, bytes);
  return path;
}
