import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type WorkspaceIdentity } from '../shared/consumption';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.object({
  id: z.string().min(1), at: count, taskId: z.string().min(1), workspaceId: z.string().min(1),
  cwd: z.string().nullable(), input: count, output: count,
}).refine(value => Number.isSafeInteger(value.input + value.output) && Number.isFinite(new Date(value.at).getTime()));
const ledgerSchema = z.object({ version: z.literal(1), algorithm: z.literal('visible-text-v1'), entries: z.array(entrySchema) });

/** Match dot-bridge's data directory; never scan its state or credentials. */
export function dotUsageFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.PASEO_DOT_BRIDGE_DATA_DIR || (env.PASEO_HOME ? join(env.PASEO_HOME, 'paseo-dot-bridge') : null);
  return root ? join(root, 'usage-estimates.json') : null;
}

type ResolveWorkspace = (workspaceId: string, cwd: string | null) => WorkspaceIdentity | undefined;
/** Only numeric estimates leave this reader. Last occurrence of a stable ID replaces earlier copies. */
export function parseDotUsage(raw: unknown, range: ConsumptionRange, resolveWorkspace?: ResolveWorkspace): ConsumptionRow[] {
  const ledger = ledgerSchema.parse(raw);
  const entries = new Map(ledger.entries.map(entry => [entry.id, entry]));
  const rows = new Map<string, ConsumptionRow>();
  for (const entry of entries.values()) {
    const date = dateInZone(new Date(entry.at), range.timezone);
    if (date < range.since || date > range.until || entry.input + entry.output === 0) continue;
    const workspace = resolveWorkspace?.(entry.workspaceId, entry.cwd);
    const key = JSON.stringify([date, workspace?.id ?? null]);
    let row = rows.get(key);
    if (!row) {
      row = { ...emptyTokens(), reasoning: null, date, model: 'dot (visible-text estimate)', inferredModel: false, ...(workspace ? { workspace } : {}) };
      rows.set(key, row);
    }
    addTokens(row, { input: entry.input, output: entry.output, cacheRead: 0, cacheWrite: 0, reasoning: null });
    if (!Number.isSafeInteger(row.input + row.output)) throw new Error('用量记录的估算合计超出范围');
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.workspace?.id ?? '').localeCompare(b.workspace?.id ?? ''));
}

export async function runDot(range: ConsumptionRange, signal: AbortSignal, file = dotUsageFile(), resolveWorkspace?: ResolveWorkspace): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  if (signal.aborted) throw new Error('读取已取消');
  if (!file) throw new Error('本机 dot 估算账本目录未配置');
  let raw: string;
  try { raw = await readFile(file, { encoding: 'utf8', signal }); }
  catch (error) {
    if (signal.aborted) throw new Error('读取已取消');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], message: 'dot 估算账本尚未生成，请更新并重新加载 dot-bridge 插件' };
    throw new Error('本机 dot 估算账本无法读取');
  }
  try {
    return { rows: parseDotUsage(JSON.parse(raw), range, resolveWorkspace), message: null };
  } catch {
    throw new Error('本机 dot 估算账本格式不兼容');
  }
}
