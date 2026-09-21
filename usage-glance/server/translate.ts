import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type Tokens } from '../shared/consumption';

/** Same ledger directory as paseo-translate's server/usage.ts. */
export function translateUsageRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_TRANSLATE_USAGE_DIR?.trim();
  return configured || join(env.PASEO_HOME || join(home, '.paseo'), 'translate', 'usage');
}

/** The translate plugin is not a Paseo Provider; its source is listed only once a ledger exists on this host. */
export async function hasTranslateLedger(root = translateUsageRoot()): Promise<boolean> {
  return stat(root).then(info => info.isDirectory(), () => false);
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
  const input = count(usage.input), output = count(usage.output), cacheRead = count(usage.cacheRead), cacheWrite = count(usage.cacheWrite);
  const reasoning = usage.reasoning == null ? null : count(usage.reasoning);
  if (!Number.isSafeInteger(input + output) || cacheRead + cacheWrite > input || (reasoning !== null && reasoning > output)) throw new Error('用量记录的 token 合计不一致');
  return { input, output, cacheRead, cacheWrite, reasoning };
}

/** Monthly files are named by UTC month; any zone shifts a record by less than a day. */
function monthsAround(range: ConsumptionRange): [string, string] {
  const day = 86400000;
  return [new Date(Date.parse(`${range.since}T00:00:00Z`) - day).toISOString().slice(0, 7), new Date(Date.parse(`${range.until}T00:00:00Z`) + day).toISOString().slice(0, 7)];
}

/** Read the translate plugin's append-only usage ledger; it never contains translated text or keys. */
export async function runTranslate(range: ConsumptionRange, signal: AbortSignal, root = translateUsageRoot()): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  const rows = new Map<string, ConsumptionRow>();
  let warnings = 0, unrecorded = 0, readable = 0, files = 0;
  const [first, last] = monthsAround(range);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], message: null }; throw new Error('本机翻译用量记录无法读取，请检查格式和读取权限'); }
  for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    checkSignal(signal);
    const month = /^(\d{4}-\d{2})\.jsonl$/.exec(item.name)?.[1];
    if (!item.isFile() || !month || month < first || month > last) continue;
    files++;
    const input = createReadStream(join(root, item.name), { encoding: 'utf8', signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        checkSignal(signal);
        if (++lineNumber % 256 === 0) await setImmediate();
        if (!line.trim()) continue;
        try {
          const entry = object(JSON.parse(line));
          if (entry.v !== 1) throw new Error('用量记录格式不兼容');
          const time = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
          if (!Number.isFinite(time)) throw new Error('用量记录缺少有效日期');
          const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model : 'Unrecorded model';
          if (model.length > 256) throw new Error('模型名称过长');
          readable++;
          const date = dateInZone(new Date(time), range.timezone);
          if (date < range.since || date > range.until) continue;
          // Gateways that answer without a usage block are counted as calls, not as zero tokens.
          if (entry.usage === null) { unrecorded++; continue; }
          const usage = tokens(entry.usage);
          const key = JSON.stringify([date, model]);
          let row = rows.get(key);
          if (!row) { row = { ...emptyTokens(), date, model, inferredModel: model === 'Unrecorded model' }; rows.set(key, row); }
          addTokens(row, usage);
        } catch { warnings++; }
      }
    } catch { checkSignal(signal); warnings++; }
    finally { lines.close(); input.destroy(); }
    await setImmediate();
  }
  checkSignal(signal);
  if (!readable && files && warnings) throw new Error('本机翻译用量记录无法读取，请检查格式和读取权限');
  const messages = [
    warnings ? `${warnings} 条翻译记录未能读取，统计可能不完整` : null,
    unrecorded ? `${unrecorded} 次翻译调用未返回 token 数，未计入` : null,
  ].filter((value): value is string => value !== null);
  return {
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    message: messages.length ? messages.join('；') : null,
  };
}
