import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dotBridgeError, type DotBridgeFailure } from '../shared/errors';
import { migrateStoreFile, storeFileSchema, type StoreFile } from '../shared/schema';

/**
 * A lock directory with no owner file is only reclaimed after this long. A concurrent `acquire`
 * creates the directory a moment before it writes the owner, so a fresh owner-less lock belongs to
 * a live process, not a crash. Reclaiming it immediately would let two processes own the store.
 */
const LOCK_GRACE_MS = 10_000;

/** PASEO_DOT_BRIDGE_DATA_DIR, or $PASEO_HOME/paseo-dot-bridge. There is no silent home fallback. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PASEO_DOT_BRIDGE_DATA_DIR) return env.PASEO_DOT_BRIDGE_DATA_DIR;
  if (env.PASEO_HOME) return join(env.PASEO_HOME, 'paseo-dot-bridge');
  return null;
}

/** Resolves the data dir or throws `data-dir-unset`, so the plugin never guesses where state lives. */
export function dotBridgeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveDataDir(env);
  if (!dir) throw dotBridgeError('data-dir-unset');
  return dir;
}

export interface StoreOptions {
  /** Test hook. Resolves only after the bytes are durable from the caller's point of view. */
  write?: (body: string) => Promise<void>;
}

function isFailure(error: unknown, code: string): error is DotBridgeFailure {
  return error instanceof Error && (error as DotBridgeFailure).code === code;
}

function emptyState(): StoreFile {
  return { version: 7, connection: null, tasks: [], events: [], dedup: { eventIds: {}, updateIds: {}, operations: {} } };
}

/**
 * One JSON file holds the connection, every task (with its messages) and the pending events, so a
 * task change and the event that announces it are written in the same atomic update. Two separate
 * files would let a saved task lose its notification. Writes are serialized and validated.
 */
export class BridgeStore {
  readonly file: string;
  readonly lockFile: string;
  readonly secretsFile: string;
  loadError: string | null = null;
  private state: StoreFile = emptyState();
  private token: string | null = null;
  private owned = false;
  private writable = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dir: string, private readonly options: StoreOptions = {}) {
    this.file = join(dir, 'state.json');
    this.lockFile = join(dir, 'state.lock');
    this.secretsFile = join(dir, 'secrets.json');
  }

  static async open(dir: string, options?: StoreOptions): Promise<BridgeStore> {
    const store = new BridgeStore(dir, options);
    try {
      await store.acquire();
      await store.load();
      store.writable = store.loadError === null;
    } catch (error) {
      store.writable = false;
      store.loadError = isFailure(error, 'store-locked') ? 'store-locked' : error instanceof Error ? error.message : String(error);
    }
    return store;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        this.loadError = 'state.json is not valid JSON';
        this.state = emptyState();
        return;
      }
      const { data, migrated } = migrateStoreFile(json);
      const parsed = storeFileSchema.safeParse(data);
      if (!parsed.success) {
        this.loadError = parsed.error.message;
        this.state = emptyState();
        return;
      }
      this.state = parsed.data;
      this.loadError = null;
      if (migrated) {
        // Keep the original bytes before committing the upgraded shape, so a bad migration can be
        // recovered by hand. The backup name records which version it came from. The write is atomic
        // (tmp + rename): a failure leaves the original file intact and the store reports the error
        // rather than silently losing data.
        const fromVersion = (json as { version?: unknown }).version;
        const backup = typeof fromVersion === 'number' ? `state.v${fromVersion}.json` : 'state.backup.json';
        try {
          await writeFile(join(this.dir, backup), raw, { mode: 0o600 });
          await this.writeBody(JSON.stringify(this.state, null, 2));
        } catch (error) {
          this.loadError = error instanceof Error ? error.message : String(error);
          this.state = emptyState();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState();
        this.loadError = null;
        return;
      }
      this.loadError = error instanceof Error ? error.message : String(error);
      this.state = emptyState();
    }
  }

  read(): StoreFile {
    return structuredClone(this.state);
  }

  /** Applies a change to a private copy and persists it atomically. The change must be synchronous. */
  async mutate<T>(change: (draft: StoreFile) => T): Promise<T> {
    if (!this.writable || !this.token) throw dotBridgeError(this.loadError === 'store-locked' ? 'store-locked' : 'store-invalid');
    let result!: T;
    const run = this.queue.then(async () => {
      // Refuse to write if the lock was reclaimed by someone else while we were idle.
      if (!(await this.ownsLock())) {
        this.writable = false;
        throw dotBridgeError('store-locked');
      }
      const draft = structuredClone(this.state);
      result = change(draft);
      const parsed = storeFileSchema.parse(draft);
      await this.writeBody(JSON.stringify(parsed, null, 2));
      this.state = parsed;
    });
    this.queue = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  async readSecrets(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.secretsFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[key] = value;
        }
        return out;
      }
      return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  /** Secrets never enter the task DTO or the client settings; they live in a 0600 file. */
  async writeSecrets(values: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `secrets.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(values, null, 2), { mode: 0o600 });
    await rename(tmp, this.secretsFile);
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.release();
  }

  private async acquire(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
    let locked = await this.tryLock();
    for (let attempt = 0; !locked && attempt < 8; attempt += 1) {
      // A previous process may have crashed while holding the lock; reclaim it only when its recorded
      // owner is provably gone, with a bounded number of attempts so we never spin forever.
      if (!(await this.lockIsStale())) throw dotBridgeError('store-locked');
      await this.reclaimStale();
      locked = await this.tryLock();
    }
    if (!locked) throw dotBridgeError('store-locked');
    // The directory is ours. Record the owner; if that write fails, remove the lock only while it is
    // still owner-less — if another process claimed it meanwhile, it is theirs, not ours.
    try {
      await writeFile(join(this.lockFile, 'owner'), token, { mode: 0o600 });
    } catch (error) {
      await this.removeIfUnowned().catch(() => undefined);
      throw error;
    }
    this.owned = true;
    this.token = token;
  }

  private async tryLock(): Promise<boolean> {
    try {
      await mkdir(this.lockFile, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /** True when this store still owns the on-disk lock (its token is the recorded owner). */
  private async ownsLock(): Promise<boolean> {
    if (!this.token) return false;
    return (await this.readToken(join(this.lockFile, 'owner'))) === this.token;
  }

  /** True when the lock's recorded owner process is no longer alive, or the record is unusable. */
  private async lockIsStale(): Promise<boolean> {
    const raw = await this.readToken(join(this.lockFile, 'owner'));
    if (raw === null) {
      // No owner yet. A fresh lock is a concurrent acquire in progress; only an old one is an orphan.
      return this.lockDirIsOld();
    }
    return this.pidIsDead(raw);
  }

  /**
   * Retires a stale lock directory. A per-store reclaim ticket serializes recoverers, and the owner
   * token is re-read immediately before removal, so only the same dead-owner lock is taken. Renaming
   * the directory aside is atomic, so a live lock acquired by another instance meanwhile is never
   * deleted out from under its owner.
   *
   * The ticket itself is recovered too: a crashed recoverer can leave an empty/corrupt ticket (a
   * crash between `open(wx)` and the write, or a dead pid), which must not block every later
   * recoverer forever. An empty ticket is only reclaimed once it is old enough that no live writer
   * could still be filling it, and a ticket is only removed while it is still ours, so one recoverer
   * can never delete another's freshly created ticket.
   */
  private async reclaimStale(): Promise<void> {
    const ticket = `${this.lockFile}.reclaim`;
    const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFile(ticket, token, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
        const held = await this.readToken(ticket);
        const reclaimable = held === null ? await this.fileIsOld(ticket) : this.pidIsDead(held);
        if (!reclaimable) return;
        // Take the stale ticket over atomically; whoever wins the rename proceeds, the loser retries.
        const graveyard = `${ticket}.stale.${randomUUID()}`;
        try {
          await rename(ticket, graveyard);
          await rm(graveyard, { force: true }).catch(() => undefined);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return;
        }
        continue;
      }
      try {
        const staleToken = await this.readToken(join(this.lockFile, 'owner'));
        const nowToken = await this.readToken(join(this.lockFile, 'owner'));
        const stillDead = nowToken === null ? await this.lockDirIsOld() : this.pidIsDead(nowToken);
        if (nowToken === staleToken && stillDead) {
          const graveyard = `${this.lockFile}.stale.${randomUUID()}`;
          try {
            await rename(this.lockFile, graveyard);
            await rm(graveyard, { recursive: true, force: true }).catch(() => undefined);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      } finally {
        // Remove the ticket only while it still holds our token; a takeover must survive.
        if ((await this.readToken(ticket)) === token) await rm(ticket, { force: true }).catch(() => undefined);
      }
      return;
    }
  }

  /** Removes the lock directory only while it still has no owner file (a failed owner write). */
  private async removeIfUnowned(): Promise<void> {
    if ((await this.readToken(join(this.lockFile, 'owner'))) !== null) return;
    await rm(this.lockFile, { recursive: true, force: true }).catch(() => undefined);
  }

  private async lockDirIsOld(): Promise<boolean> {
    return this.fileIsOld(this.lockFile);
  }

  private async fileIsOld(file: string): Promise<boolean> {
    try {
      const info = await stat(file);
      return Date.now() - info.mtimeMs > LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  private pidIsDead(token: string | null): boolean {
    if (token === null) return false;
    const pid = Number(token.split(':')[0]);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /** Reads a token file, treating a missing or empty file as no owner. */
  private async readToken(file: string): Promise<string | null> {
    try {
      const raw = await readFile(file, 'utf8');
      return raw.trim() === '' ? null : raw;
    } catch {
      return null;
    }
  }

  private async release(): Promise<void> {
    const owned = this.owned;
    const token = this.token;
    this.owned = false;
    this.token = null;
    this.writable = false;
    if (!owned) return;
    // Never delete a lock we no longer own: another process may have reclaimed it.
    if (!(await this.ownsToken(token))) return;
    await rm(this.lockFile, { recursive: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  private async ownsToken(token: string | null): Promise<boolean> {
    if (!token) return false;
    try {
      return (await readFile(join(this.lockFile, 'owner'), 'utf8')) === token;
    } catch {
      return false;
    }
  }

  private async writeBody(body: string): Promise<void> {
    if (this.options.write) {
      await this.options.write(body);
      return;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `state.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
