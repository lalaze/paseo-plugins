import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { todoError, type TodoFailure } from '../shared/errors';
import { storeFileSchema, taskSchema, type Task } from '../shared/schema';

export function todoDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_TODO_DATA_DIR ?? join(env.PASEO_HOME ?? join(homedir(), '.paseo'), 'paseo-todo');
}

export interface StoreOptions {
  /** Test hook. Resolves only after the bytes are durable from the caller's point of view. */
  write?: (body: string) => Promise<void>;
}

function isTodoFailure(error: unknown, code: string): error is TodoFailure {
  return error instanceof Error && (error as TodoFailure).code === code;
}

export class TaskStore {
  readonly file: string;
  readonly lockFile: string;
  loadError: string | null = null;
  private tasks: Task[] = [];
  private token: string | null = null;
  /** True only after this process creates the lock directory. Never stolen from another process. */
  private owned = false;
  private writable = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dir: string, private readonly options: StoreOptions = {}) {
    this.file = join(dir, 'state.json');
    this.lockFile = join(dir, 'state.lock');
  }

  static async open(dir: string, options?: StoreOptions): Promise<TaskStore> {
    const store = new TaskStore(dir, options);
    try {
      await store.acquire();
      await store.load();
      store.writable = store.loadError === null;
    } catch (error) {
      store.writable = false;
      store.loadError = isTodoFailure(error, 'store-locked') ? 'store-locked' : error instanceof Error ? error.message : String(error);
    }
    return store;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = storeFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.loadError = parsed.error.message;
        this.tasks = [];
        return;
      }
      this.tasks = parsed.data.tasks;
      this.loadError = null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.tasks = [];
        this.loadError = null;
        return;
      }
      this.loadError = error instanceof Error ? error.message : String(error);
      this.tasks = [];
    }
  }

  list(): Task[] {
    return this.tasks.map(task => structuredClone(task));
  }

  tryGet(id: string): Task | null {
    const task = this.tasks.find(item => item.id === id);
    return task ? structuredClone(task) : null;
  }

  get(id: string): Task {
    const task = this.tryGet(id);
    if (!task) throw todoError('task-missing');
    return task;
  }

  async insert(task: Task): Promise<void> {
    const parsed = taskSchema.parse(task);
    await this.transaction(current => {
      if (current.some(item => item.id === parsed.id)) throw new Error('任务 id 已存在');
      return [...current, parsed];
    });
  }

  async replace(task: Task): Promise<void> {
    const parsed = taskSchema.parse(task);
    await this.transaction(current => {
      const index = current.findIndex(item => item.id === parsed.id);
      if (index < 0) throw todoError('task-missing');
      const next = current.slice();
      next[index] = parsed;
      return next;
    });
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.release();
  }

  private async acquire(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.lockFile, { mode: 0o700 });
    } catch (error) {
      // Existence is the lock. An empty file, a dead pid, or a directory whose owner
      // record is not written yet can belong to another process, so it is left in place.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw todoError('store-locked');
      throw error;
    }
    this.owned = true;
    this.token = `${process.pid}:${randomUUID()}`;
    await writeFile(join(this.lockFile, 'owner'), this.token, { mode: 0o600 }).catch(() => undefined);
  }

  private async release(): Promise<void> {
    const owned = this.owned;
    this.owned = false;
    this.token = null;
    this.writable = false;
    if (!owned) return;
    await rm(this.lockFile, { recursive: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  private async transaction(change: (current: Task[]) => Task[]): Promise<void> {
    if (!this.writable || !this.token) throw todoError(this.loadError === 'store-locked' ? 'store-locked' : 'store-invalid');
    const run = this.queue.then(async () => {
      const next = change(this.tasks.map(task => structuredClone(task)));
      const body = JSON.stringify({ version: 1, tasks: next }, null, 2);
      storeFileSchema.parse(JSON.parse(body));
      await this.writeBody(body);
      this.tasks = next;
    });
    this.queue = run.then(() => undefined, () => undefined);
    await run;
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
