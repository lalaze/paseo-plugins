import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHUNK_SIZE, MAX_FILE_SIZE } from '../shared/files.shared';

interface Upload { file: FileHandle; temp: string; target: string; root: string; relative: string; size: number; offset: number; touched: number; busy: boolean }
export class FileService {
  private uploads = new Map<string, Upload>();
  // Sessions are bounded and abandoned partial uploads are removed automatically.
  private timer = setInterval(() => { void this.expire().catch(() => {}); }, 60_000);
  constructor() { this.timer.unref(); }
  async resolve(root: string, relative: string, missingLeaf = false) {
    if (relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('File paths must stay within the current workspace');
    const base = await realpath(root);
    const parts = relative.split('/').filter(p => p && p !== '.');
    let current = base;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '.git' || parts[i].startsWith('.paseo-upload-')) throw new Error('Internal files cannot be accessed');
      current = path.join(current, parts[i]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported');
      } catch (e) {
        if (missingLeaf && i === parts.length - 1 && (e as NodeJS.ErrnoException).code === 'ENOENT') return current;
        throw e;
      }
    }
    return current;
  }
  async list(root: string, relative: string) {
    const dir = await this.resolve(root, relative);
    const entries = await readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name.startsWith('.paseo-upload-') || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      try {
        const info = await lstat(path.join(dir, entry.name));
        result.push({ name: entry.name, path: [relative, entry.name].filter(Boolean).join('/'), directory: info.isDirectory(), size: info.size });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  async start(root: string, relative: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) throw new Error('The maximum file size is 100 MiB');
    if (this.uploads.size >= 8) throw new Error('Too many uploads are active; try again later');
    const target = await this.resolve(root, relative, true);
    try { await lstat(target); throw new Error('A file with this name already exists; rename it before uploading'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const id = randomUUID();
    const temp = path.join(path.dirname(target), `.paseo-upload-${id}`);
    const file = await open(temp, 'wx', 0o600);
    this.uploads.set(id, { file, temp, target, root, relative, size, offset: 0, touched: Date.now(), busy: false });
    return { id };
  }
  private session(id: string) {
    const upload = this.uploads.get(id);
    if (!upload) throw new Error('The upload session has expired; start the upload again');
    if (upload.busy) throw new Error('The upload is being processed');
    upload.touched = Date.now();
    return upload;
  }
  async chunk(id: string, offset: number, data: string) {
    const upload = this.session(id);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || !bytes.length || bytes.length > CHUNK_SIZE || offset !== upload.offset || offset + bytes.length > upload.size) throw new Error('Invalid upload chunk');
    upload.busy = true;
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await upload.file.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('Unable to write the file');
        written += result.bytesWritten;
      }
      upload.offset += written;
      return { offset: upload.offset };
    } finally { upload.busy = false; }
  }
  async finish(id: string) {
    const upload = this.session(id);
    if (upload.offset !== upload.size) throw new Error('The file upload is incomplete');
    upload.busy = true;
    try {
      if (await this.resolve(upload.root, upload.relative, true) !== upload.target) throw new Error('The destination directory has changed');
      await upload.file.sync();
      await upload.file.close();
      // Hard-link publication is atomic and never replaces an existing destination.
      await link(upload.temp, upload.target);
      await unlink(upload.temp);
      this.uploads.delete(id);
      return { ok: true };
    } finally { upload.busy = false; }
  }
  async cancel(id: string) {
    const upload = this.uploads.get(id);
    if (upload) {
      if (upload.busy) throw new Error('The upload is being processed');
      this.uploads.delete(id);
      await upload.file.close().catch(() => {});
      await unlink(upload.temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    return { ok: true };
  }
  async download(root: string, relative: string, offset: number, version?: string) {
    const filename = await this.resolve(root, relative);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_SIZE) throw new Error('Only regular files up to 100 MiB can be downloaded');
      const current = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (version && version !== current) throw new Error('The file changed during download; try again');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size || (offset > 0 && !version)) throw new Error('Invalid download offset');
      const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, info.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const after = await file.stat();
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== current) throw new Error('The file changed during download; try again');
      return { data: buffer.subarray(0, bytesRead).toString('base64'), size: info.size, version: current, nextOffset: offset + bytesRead };
    } finally { await file.close(); }
  }
  private async expire() {
    for (const [id, upload] of this.uploads) if (!upload.busy && Date.now() - upload.touched > 15 * 60_000) await this.cancel(id);
  }
  async dispose() { clearInterval(this.timer); for (const id of this.uploads.keys()) await this.cancel(id); }
}
