import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FileService } from '../server/files.server';
import { CHUNK_SIZE, MAX_FILE_SIZE } from '../shared/files.shared';

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-transfer-test-'));
  const service = new FileService();
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, service };
}

test('binary upload and chunked download preserve exact bytes, including Unicode names', async t => {
  const { root, service } = await setup(t);
  const data = randomBytes(CHUNK_SIZE * 2 + 17);
  const { id } = await service.start(root, '图片 文件.bin', data.length);
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) await service.chunk(id, offset, data.subarray(offset, offset + CHUNK_SIZE).toString('base64'));
  assert.deepEqual(await service.list(root, ''), []);
  await service.finish(id);
  assert.deepEqual(await readFile(path.join(root, '图片 文件.bin')), data);
  const parts: Buffer[] = [];
  let offset = 0, version: string | undefined;
  do {
    const result = await service.download(root, '图片 文件.bin', offset, version);
    parts.push(Buffer.from(result.data, 'base64')); offset = result.nextOffset; version = result.version;
  } while (offset < data.length);
  assert.deepEqual(Buffer.concat(parts), data);
});

test('zero byte files and nested directories', async t => {
  const { root, service } = await setup(t);
  await mkdir(path.join(root, '子目录'));
  const { id } = await service.start(root, '子目录/empty', 0);
  await service.finish(id);
  assert.equal((await service.download(root, '子目录/empty', 0)).size, 0);
  assert.equal((await service.list(root, ''))[0].directory, true);
});

test('refuses traversal, absolute paths, internal files and symlinks', async t => {
  const { root, service } = await setup(t);
  await symlink(tmpdir(), path.join(root, 'outside'));
  for (const target of ['../escape', '/tmp/escape', 'a/../../escape', 'outside/escape', '.git/config', '.paseo-upload-fake', 'a\\b']) {
    await assert.rejects(service.start(root, target, 0));
  }
  assert.deepEqual(await service.list(root, ''), []);
});

test('never overwrites even when destination is created during upload', async t => {
  const { root, service } = await setup(t);
  const { id } = await service.start(root, 'same', 0);
  await writeFile(path.join(root, 'same'), 'original');
  await assert.rejects(service.finish(id));
  await service.cancel(id);
  await assert.rejects(service.start(root, 'same', 0));
  assert.equal(await readFile(path.join(root, 'same'), 'utf8'), 'original');
});

test('rejects invalid chunks and incomplete publication; cancellation removes partials', async t => {
  const { root, service } = await setup(t);
  const { id } = await service.start(root, 'partial', 3);
  await assert.rejects(service.chunk(id, 1, 'YWJj'));
  await assert.rejects(service.chunk(id, 0, '!!!!'));
  await assert.rejects(service.chunk(id, 0, 'YWJjZA=='));
  await assert.rejects(service.finish(id));
  await service.chunk(id, 0, 'YQ==');
  await service.cancel(id);
  await service.cancel(id);
  assert.deepEqual(await readdir(root), []);
});

test('download detects file changes between chunks', async t => {
  const { root, service } = await setup(t);
  await writeFile(path.join(root, 'changing'), randomBytes(CHUNK_SIZE + 20));
  const first = await service.download(root, 'changing', 0);
  await writeFile(path.join(root, 'changing'), 'changed');
  await assert.rejects(service.download(root, 'changing', first.nextOffset, first.version), /变化/);
});

test('limits file size, concurrent sessions, and cleans on shutdown', async t => {
  const { root, service } = await setup(t);
  await assert.rejects(service.start(root, 'huge', MAX_FILE_SIZE + 1));
  for (let i = 0; i < 8; i++) await service.start(root, `file-${i}`, 1);
  await assert.rejects(service.start(root, 'extra', 1), /过多/);
  await service.dispose();
  assert.deepEqual(await readdir(root), []);
});
