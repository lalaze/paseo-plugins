import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { remoteConfigSchema, remoteDeviceSchema } from '../shared/remote';
import { taskSchema } from '../shared/schema';

export const fileJobSchema = z.object({
  id: z.string().uuid(), deviceId: z.string().uuid(), taskId: z.string().uuid(), roundId: z.string().uuid(),
  userMessageSeq: z.number().int().nonnegative(), kind: z.enum(['list', 'read', 'changes', 'apply']),
  input: z.record(z.string(), z.unknown()), hash: z.string(), expiresAt: z.number(),
  status: z.enum(['queued', 'leased', 'done', 'failed']), result: z.unknown().optional(), error: z.string().nullable(),
});
export type FileJob = z.infer<typeof fileJobSchema>;
const stateSchema = z.object({
  version: z.literal(1), config: remoteConfigSchema,
  token: z.string(), devices: z.array(remoteDeviceSchema.extend({ tokenHash: z.string() })),
  jobs: z.array(fileJobSchema),
  bindings: z.array(z.object({ taskId: z.string().uuid(), workspaceId: z.string(), cwd: z.string() })),
  stops: z.array(z.object({ taskId: z.string().uuid(), roundId: z.string().uuid(), operationId: z.string().uuid() })),
  cache: z.array(taskSchema),
  results: z.array(z.object({ job: fileJobSchema, phase: z.enum(['intent', 'ready']), result: z.unknown().optional(), error: z.string().nullable() })).default([]),
  deliveries: z.array(z.object({ taskId: z.string().uuid(), attachmentId: z.string().uuid(), path: z.string(), sha256: z.string(), confirmed: z.boolean().default(false) })).default([]),
});
export type RemoteStored = z.infer<typeof stateSchema>;
/** Separate from bridge state; tokens are never returned in a status DTO. One daemon owns this file. */
export class RemoteStateStore {
  private value: RemoteStored = { version: 1, config: remoteConfigSchema.parse({}), token: '', devices: [], jobs: [], bindings: [], stops: [], cache: [], deliveries: [], results: [] };
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<void> {
    const path = join(this.dir, 'remote.json');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe remote state file');
      this.value = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Remote state could not be loaded'); }
  }
  read(): RemoteStored { return structuredClone(this.value); }
  async mutate<T>(change: (draft: RemoteStored) => T): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const draft = this.read(); result = change(draft);
      const parsed = stateSchema.parse(draft);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = join(this.dir, 'remote.json'), temporary = join(this.dir, 'remote.' + randomUUID() + '.tmp');
      const file = await open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(JSON.stringify(parsed)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        // Keep memory aligned with the renamed file even if the directory sync reports an error.
        this.value = parsed;
        const directory = await open(this.dir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation; return result;
  }
  async flush() { await this.queue; }
}
