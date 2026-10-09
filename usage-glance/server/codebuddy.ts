import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type Tokens, type WorkspaceIdentity } from '../shared/consumption';

/** Same config-directory override (including ~ expansion) as CodeBuddy's config resolution. */
export function codebuddySessionsRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEBUDDY_CONFIG_DIR || join(home, '.codebuddy');
  const root = configured === '~' ? home : /^~[/\\]/.test(configured) ? join(home, configured.slice(2)) : configured;
  return join(root, 'projects');
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
function detailSum(value: unknown, key: string): number | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error('用量记录格式不兼容');
  let sum = 0;
  for (const entry of value) {
    const detail = object(entry)[key];
    sum += detail == null ? 0 : count(detail);
  }
  return sum;
}
function tokens(record: ObjectValue): Tokens | null {
  // Steps without a recorded model request have no providerData at all.
  if (record.providerData == null) return null;
  const providerData = object(record.providerData);
  if (providerData.usage === undefined) return null;
  const usage = object(providerData.usage);
  const inputTokens = count(usage.inputTokens), output = count(usage.outputTokens);
  const cacheRead = detailSum(usage.inputTokensDetails, 'cached_tokens') ?? 0;
  const reasoning = detailSum(usage.outputTokensDetails, 'reasoning_tokens');
  let cacheWrite = 0;
  if (providerData.rawUsage !== undefined) {
    const raw = object(providerData.rawUsage);
    cacheWrite = raw.cache_creation_input_tokens == null ? 0 : count(raw.cache_creation_input_tokens);
  }
  // Cache reads are already part of inputTokens; cache writes are billed separately.
  const input = inputTokens + cacheWrite;
  if (cacheRead > inputTokens || !Number.isSafeInteger(input + output) || (reasoning !== null && reasoning > output)) throw new Error('用量记录的 token 合计不一致');
  if (usage.totalTokens !== undefined) {
    const total = count(usage.totalTokens);
    if (total !== inputTokens + output && total !== input + output) throw new Error('用量记录的 token 合计不一致');
  }
  return { input, output, cacheRead, cacheWrite, reasoning };
}
function timestamp(value: unknown): number {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(new Date(time).getTime())) throw new Error('用量记录缺少有效日期');
  return time;
}

/** Read retained CodeBuddy session records. Each model request persists usage on exactly one record per step. */
export async function runCodebuddy(range: ConsumptionRange, signal: AbortSignal, root = codebuddySessionsRoot(), resolveWorkspace?: (id?: string, cwd?: string) => WorkspaceIdentity | undefined): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
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
      let lineNumber = 0, parsed = 0;
      const legacyOccurrences = new Map<string, number>();
      try {
        for await (const line of lines) {
          checkSignal(signal);
          if (++lineNumber % 256 === 0) await setImmediate();
          if (!line.trim()) continue;
          let entry: ObjectValue;
          try { entry = object(JSON.parse(line)); } catch { warnings++; continue; }
          parsed++;
          try {
            if (entry.type === 'message') {
              if (entry.role !== 'assistant') continue;
            } else if (entry.type !== 'function_call') continue;
            const usage = tokens(entry);
            if (usage === null) continue;
            const time = timestamp(entry.timestamp);
            const date = dateInZone(new Date(time), range.timezone);
            if (date < range.since || date > range.until) continue;
            const providerData = object(entry.providerData);
            const model = typeof providerData.model === 'string' && providerData.model.trim() ? providerData.model : 'Unrecorded model';
            if (model.length > 256) throw new Error('模型名称过长');
            const workspace = resolveWorkspace?.(typeof entry.sessionId === 'string' ? entry.sessionId : undefined, typeof entry.cwd === 'string' ? entry.cwd : undefined);
            // File copies retain record IDs; include the model and payload hash so independent
            // requests with identical usage in different sessions are both kept.
            const digest = createHash('sha256').update(JSON.stringify([entry.type, time, model, providerData.usage])).digest('hex');
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
        if (!parsed) warnings++;
      } catch { checkSignal(signal); warnings++; }
      finally { lines.close(); input.destroy(); }
      if (parsed) readable++;
      await setImmediate();
    }
  }
  checkSignal(signal);
  if (!readable && (files || warnings)) throw new Error('本机 CodeBuddy 用量记录无法读取，请检查格式和读取权限');
  for (const usage of seen.values()) {
    const key = JSON.stringify([usage.date, usage.model, usage.workspace?.id]);
    let row = rows.get(key);
    if (!row) { row = { ...usage, ...emptyTokens() }; rows.set(key, row); }
    addTokens(row, usage);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    message: warnings ? `${warnings} 个 CodeBuddy 文件或记录未能读取，统计可能不完整` : null,
  };
}
