import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { commandSpecSchema, type CommandSpec } from '../shared/processes';
import { canonicalJson } from '../shared/mcp';
import { dotBridgeError } from '../shared/errors';
import { validateLocalPath } from './local-files';

const LOG_LIMIT = 256 * 1024;
const PAGE_SIZE = 16 * 1024;
const activeStates = new Set(['reserved', 'starting', 'running', 'stopping']);
const recordSchema = z.object({
  operationId: z.string().uuid(), taskId: z.string().uuid(), roundId: z.string().uuid(),
  root: z.string(), spec: commandSpecSchema,
  status: z.enum(['reserved', 'starting', 'running', 'stopping', 'exited', 'failed', 'stopped', 'timed-out', 'interrupted']),
  pid: z.number().int().positive().nullable(), startedAt: z.number(), endedAt: z.number().nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), error: z.string(),
  log: z.string().max(LOG_LIMIT), logStart: z.number().int().nonnegative(), logEnd: z.number().int().nonnegative(),
});
type ProcessRecord = z.infer<typeof recordSchema>;
type Identity = { taskId: string; roundId: string; operationId: string };
type LiveProcess = { child: ChildProcess; timer: ReturnType<typeof setTimeout>; flush?: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void; reason?: 'stopped' | 'timed-out'; stopping?: Promise<void> };

/** Validate the initial cwd only. Host commands are deliberately not presented as sandboxed. */
export function commandDirectory(root: string, cwd: string): string {
  const parts = validateLocalPath(cwd, true);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw dotBridgeError('task-rejected', 'Workspace root changed');
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw dotBridgeError('task-rejected', 'Command cwd must be an ordinary workspace directory');
  }
  return dir;
}

export class ProcessManager {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly live = new Map<string, LiveProcess>();
  private readonly unloadedLogs = new Set<string>();
  private readonly dir: string;
  private closed = false;

  constructor(dataDir: string) { this.dir = join(dataDir, 'processes'); }

  init(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const names = readdirSync(this.dir).filter(name => name.endsWith('.json'));
    if (names.length > 5000) throw dotBridgeError('task-rejected', 'Process journal limit exceeded');
    for (const name of names) {
      const record = recordSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
      if (name !== `${record.operationId}.json`) throw dotBridgeError('task-rejected', 'Process journal identity mismatch');
      if (activeStates.has(record.status)) {
        record.status = 'interrupted'; record.endedAt = Date.now();
        record.error = 'Daemon restarted; execution outcome and external process state are unknown. Not resumed.';
        this.persist(record);
      }
      record.log = ''; // Historical log pages are loaded on demand, not all into daemon memory.
      this.unloadedLogs.add(record.operationId);
      this.records.set(record.operationId, record);
    }
  }

  private persist(record: ProcessRecord): void {
    const temporary = join(this.dir, `${record.operationId}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(this.dir, `${record.operationId}.json`));
    const directory = openSync(this.dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  prior(input: Identity, root: string, spec: CommandSpec): ProcessRecord | undefined {
    const previous = this.records.get(input.operationId);
    if (previous && (previous.taskId !== input.taskId || previous.roundId !== input.roundId || previous.root !== root || canonicalJson(previous.spec) !== canonicalJson(spec))) throw dotBridgeError('duplicate-mismatch');
    return previous;
  }

  reserve(input: Identity, root: string, spec: CommandSpec): void {
    if (this.closed) throw dotBridgeError('task-rejected', 'Process manager is shutting down');
    if (this.records.size >= 5000 || [...this.records.values()].filter(record => activeStates.has(record.status)).length >= 8) throw dotBridgeError('task-rejected', 'Process journal or active process limit reached');
    commandDirectory(root, spec.cwd);
    const record: ProcessRecord = recordSchema.parse({ operationId: input.operationId, taskId: input.taskId, roundId: input.roundId, root, spec, status: 'reserved', pid: null, startedAt: Date.now(), endedAt: null, exitCode: null, signal: null, error: '', log: '', logStart: 0, logEnd: 0 });
    // Durable intent precedes permission consumption and spawn. Uncertain retries never spawn again.
    this.persist(record); this.records.set(input.operationId, record);
  }

  fail(id: string, error: unknown): void {
    const record = this.records.get(id)!;
    record.status = 'failed'; record.endedAt = Date.now(); record.error = String(error).slice(0, 2000);
    this.persist(record);
  }

  start(id: string): void {
    const record = this.records.get(id)!;
    if (record.status !== 'reserved' || this.closed) throw dotBridgeError('task-rejected', 'Process cannot be started');
    const cwd = commandDirectory(record.root, record.spec.cwd);
    record.status = 'starting'; this.persist(record);
    // Do not pass the daemon's tokens or arbitrary secret environment variables to projects.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(record.spec.command, record.spec.args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let resolve!: () => void;
    const done = new Promise<void>(finish => { resolve = finish; });
    const live: LiveProcess = { child, done, resolve, timer: setTimeout(() => { void this.stop(id, 'timed-out').catch(error => console.error('[dot-bridge] process timeout', error)); }, record.spec.timeoutMs) };
    this.live.set(id, live);
    const save = () => { try { this.persist(record); } catch (error) { record.error = `Process journal write failed: ${String(error)}`.slice(0, 2000); void this.stop(id).catch(() => {}); } };
    child.once('spawn', () => { record.pid = child.pid ?? null; if (record.status === 'starting') record.status = 'running'; save(); });
    const append = (chunk: string) => {
      record.log += chunk; record.logEnd += chunk.length;
      if (record.log.length > LOG_LIMIT) { record.log = record.log.slice(-LOG_LIMIT); record.logStart = record.logEnd - record.log.length; }
      if (!live.flush) live.flush = setTimeout(() => { live.flush = undefined; save(); }, 100);
    };
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', append); child.stderr!.on('data', append);
    child.once('error', error => { record.error = error.message.slice(0, 2000); });
    child.once('exit', (code, signal) => {
      clearTimeout(live.timer);
      record.exitCode = code; record.signal = signal; record.endedAt = Date.now();
      record.status = live.reason ?? (record.error ? 'failed' : 'exited');
      save();
      // Descendants may retain stdout/stderr, delaying `close` indefinitely. Reap on leader exit.
      void this.stop(id).catch(error => console.error('[dot-bridge] process cleanup', error));
    });
    child.once('close', (code, signal) => {
      clearTimeout(live.timer); if (live.flush) clearTimeout(live.flush);
      record.exitCode = code; record.signal = signal; record.endedAt = Date.now();
      record.status = live.reason ?? (record.error ? 'failed' : 'exited');
      save(); live.resolve();
      // Also reap ordinary descendants if the command's leader exits first.
      void this.stop(id).catch(error => console.error('[dot-bridge] process cleanup', error));
    });
  }

  private signal(live: LiveProcess, signal: NodeJS.Signals): boolean {
    if (!live.child.pid) return false;
    try {
      if (process.platform === 'win32') return live.child.kill(signal);
      process.kill(-live.child.pid, signal);
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
  }

  async stop(id: string, reason: 'stopped' | 'timed-out' = 'stopped'): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    if (live.stopping) return live.stopping;
    if (activeStates.has(this.records.get(id)!.status)) {
      live.reason = reason; this.records.get(id)!.status = 'stopping';
    }
    live.stopping = (async () => {
      const signaled = this.signal(live, 'SIGTERM');
      // Keep escalation even when the leader has exited: descendants can still own its group.
      if (signaled) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.signal(live, 'SIGKILL');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([live.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Process stop remains unconfirmed')), 2000); })]);
        const record = this.records.get(id)!;
        // Only discard memory after a successful final save; failed journals retain their output.
        try { this.persist(record); record.log = ''; this.unloadedLogs.add(id); }
        catch (error) { record.error = `Process journal write failed: ${String(error)}`.slice(0, 2000); }
        this.live.delete(id);
      } finally { if (timer) clearTimeout(timer); }
    })();
    return live.stopping;
  }

  async stopTask(taskId: string): Promise<void> {
    await Promise.all([...this.live.keys()].filter(id => this.records.get(id)!.taskId === taskId).map(id => this.stop(id)));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
  }

  async wait(id: string, waitMs: number): Promise<void> {
    const live = this.live.get(id);
    if (!live || waitMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([live.done, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  read(input: Identity, offset = 0) {
    const record = this.records.get(input.operationId);
    if (!record || record.taskId !== input.taskId || record.roundId !== input.roundId) throw dotBridgeError('task-rejected', 'Process does not belong to this task/round');
    if (offset > record.logEnd) throw dotBridgeError('task-rejected', 'Log offset is ahead of the process output');
    const start = Math.max(offset, record.logStart);
    let log = record.log;
    if (this.unloadedLogs.has(input.operationId)) {
      const saved = recordSchema.parse(JSON.parse(readFileSync(join(this.dir, `${input.operationId}.json`), 'utf8')));
      if (saved.operationId !== input.operationId || saved.taskId !== input.taskId || saved.roundId !== input.roundId) throw dotBridgeError('task-rejected', 'Process journal identity mismatch');
      log = saved.log;
    }
    const output = log.slice(start - record.logStart, start - record.logStart + PAGE_SIZE);
    const { log: _log, root: _root, ...summary } = record;
    return { ...structuredClone(summary), output, offset: start, nextOffset: start + output.length, truncated: offset < record.logStart };
  }

  list(taskId: string) {
    return [...this.records.values()].filter(record => record.taskId === taskId).map(record => {
      const { log: _log, root: _root, ...summary } = record;
      return structuredClone(summary);
    }).slice(-100);
  }
}
