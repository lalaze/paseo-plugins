import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type Tokens, type WorkspaceIdentity } from '../shared/consumption';

/** Same agent-directory override (including ~ expansion) as Pi's config.ts. */
export function piSessionsRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
  const root = configured === '~' ? home : /^~[/\\]/.test(configured) ? join(home, configured.slice(2)) : configured;
  return join(root, 'sessions');
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw Object.assign(new Error('读取已取消'), { name: 'AbortError' });
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('用量记录格式不兼容');
  return value as ObjectValue;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('用量记录缺少有效 token 数');
  return value;
}
function tokens(raw: unknown): Tokens {
  const usage = object(raw);
  const cacheRead = count(usage.cacheRead), cacheWrite = count(usage.cacheWrite);
  const input = count(usage.input) + cacheRead + cacheWrite, output = count(usage.output);
  const reasoning = usage.reasoning == null ? null : count(usage.reasoning);
  if (!Number.isSafeInteger(input + output) || (reasoning !== null && reasoning > output)) throw new Error('用量记录的 token 合计不一致');
  // totalTokens and cost are provider metadata, not additional consumption.
  return { input, output, cacheRead, cacheWrite, reasoning };
}
function timestamp(value: unknown): number {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(new Date(time).getTime())) throw new Error('用量记录缺少有效日期');
  return time;
}

/** Read retained v1-v3 session entries, including all branches, without sending transcripts. */
export async function runPi(range: ConsumptionRange, signal: AbortSignal, root = piSessionsRoot(), resolveWorkspace?: (id?: string, cwd?: string) => WorkspaceIdentity | undefined): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  const rows = new Map<string, ConsumptionRow>(), seen = new Map<string, ConsumptionRow>();
  let warnings = 0, readable = 0, files = 0;
  const directories = [root];
  while (directories.length) {
    checkSignal(signal);
    const directory = directories.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory !== root) warnings++; continue; }
    for (const item of entries) {
      checkSignal(signal);
      const path = join(directory, item.name);
      // Do not follow directory symlinks into cycles or unrelated data.
      if (item.isDirectory()) { directories.push(path); continue; }
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      files++;
      const input = createReadStream(path, { encoding: 'utf8', signal });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let header = false, lineNumber = 0;
      let workspace: WorkspaceIdentity | undefined;
      const legacyOccurrences = new Map<string, number>();
      try {
        for await (const line of lines) {
          checkSignal(signal);
          if (++lineNumber % 256 === 0) await setImmediate();
          if (!line.trim()) continue;
          try {
            const entry = object(JSON.parse(line));
            if (!header) {
              if (entry.type !== 'session' || ![1, 2, 3].includes(Number(entry.version ?? 1))) { warnings++; break; }
              workspace = resolveWorkspace?.(typeof entry.id === 'string' ? entry.id : undefined, typeof entry.cwd === 'string' ? entry.cwd : undefined);
              header = true; readable++; continue;
            }
            let payload: ObjectValue;
            if (entry.type === 'message') {
              payload = object(entry.message);
              if (payload.role !== 'assistant') continue;
            } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
              // Older versions did not persist summary usage; tokensBefore is context size.
              if (entry.usage === undefined) continue;
              payload = entry;
            } else continue;
            const usage = tokens(payload.usage), time = timestamp(payload.timestamp ?? entry.timestamp);
            const date = dateInZone(new Date(time), range.timezone);
            if (date < range.since || date > range.until) continue;
            const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model : 'Unrecorded model';
            if (model.length > 256) throw new Error('模型名称过长');
            // Forks retain entry IDs and message timestamps. Include the payload hash:
            // old IDs are only 8 hex characters and can collide across unrelated sessions.
            const digest = createHash('sha256').update(JSON.stringify([entry.type, time, payload])).digest('hex');
            const occurrence = (legacyOccurrences.get(digest) ?? 0) + 1;
            legacyOccurrences.set(digest, occurrence);
            const identity = `${typeof entry.id === 'string' ? entry.id : occurrence}:${digest}`;
            const previous = seen.get(identity);
            if (previous) {
              // Copies in different workspaces do not establish which spent the tokens.
              if (previous.workspace?.id !== workspace?.id) delete previous.workspace;
            } else seen.set(identity, { ...usage, date, model, inferredModel: model === 'Unrecorded model', ...(workspace ? { workspace } : {}) });
          } catch { warnings++; }
        }
        if (!header && !lineNumber) warnings++;
      } catch { checkSignal(signal); warnings++; }
      finally { lines.close(); input.destroy(); }
      await setImmediate();
    }
  }
  checkSignal(signal);
  if (!readable && (files || warnings)) throw new Error('本机 Pi 用量记录无法读取，请检查格式和读取权限');
  for (const usage of seen.values()) {
    const key = JSON.stringify([usage.date, usage.model, usage.workspace?.id]);
    let row = rows.get(key);
    if (!row) { row = { ...usage, ...emptyTokens() }; rows.set(key, row); }
    addTokens(row, usage);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    message: warnings ? `${warnings} 个 Pi 文件或记录未能读取，统计可能不完整` : null,
  };
}
