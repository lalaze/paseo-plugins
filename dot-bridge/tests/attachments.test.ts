import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AttachmentStore, decodeAttachment } from '../server/attachments';
import { attachmentContentSchema, MAX_ATTACHMENT_BYTES } from '../shared/attachments';

it('preserves binary bytes at the size limit and detects corrupted stored blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-attachments-'));
  try {
    const store = new AttachmentStore(dir);
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const input = { name: 'sample.bin', mediaType: 'application/octet-stream', encoding: 'base64' as const, content: bytes.toString('base64') };
    assert.deepEqual(decodeAttachment(input), bytes);
    const sha256 = await store.put(bytes);
    const metadata = { id: 'a', roundId: 'b', name: input.name, mediaType: input.mediaType, size: bytes.length, sha256, author: 'user' as const, createdAt: 0 };
    assert.deepEqual(await store.get(metadata), bytes);
    assert.equal(await store.put(bytes), sha256);
    assert.deepEqual(await readFile(join(dir, 'attachments', sha256)), bytes);
    await writeFile(join(dir, 'attachments', sha256), 'corrupt');
    await assert.rejects(store.get(metadata), /integrity/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('rejects paths, invalid base64 and oversized Unicode content before storage', () => {
  const input = { name: 'note.txt', mediaType: 'text/plain', encoding: 'utf8' as const, content: '中文' };
  assert.equal(decodeAttachment(input).toString(), '中文');
  for (const name of ['../note', 'a/b', 'a\\b', '.', '..', 'bad\nname']) assert.equal(attachmentContentSchema.safeParse({ ...input, name }).success, false);
  for (const content of ['SGVsbG8', '@@@@', 'YQ==\n', 'YR==']) assert.throws(() => decodeAttachment({ ...input, encoding: 'base64', content }));
  assert.throws(() => decodeAttachment({ ...input, content: '中'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3)) }), /attachment-too-large/);
  assert.throws(() => decodeAttachment({ ...input, encoding: 'base64', content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }));
});
