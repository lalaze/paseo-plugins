import { execFile } from 'node:child_process';
import { backend } from './backend.generated';
import { consumptionRowSchema, dateSchema, emptyTokens, addTokens, type ConsumptionRange, type ConsumptionRow, type SourceId } from '../shared/consumption';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('用量记录格式不兼容');
  return value as ObjectValue;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('用量记录缺少有效 token 数');
  return value;
}
function tokens(value: ObjectValue) {
  const cacheRead = count(value.cacheReadTokens), cacheWrite = count(value.cacheCreationTokens);
  const input = count(value.inputTokens) + cacheRead + cacheWrite;
  const output = count(value.outputTokens);
  const reasoning = value.reasoningOutputTokens == null ? null : count(value.reasoningOutputTokens);
  if (!Number.isSafeInteger(input + output) || (reasoning !== null && reasoning > output)) throw new Error('用量记录的 token 合计不一致');
  if (value.totalTokens !== undefined && count(value.totalTokens) !== input + output) throw new Error('用量记录的 token 合计不一致');
  return { input, output, cacheRead, cacheWrite, reasoning };
}

/** ccusage focused reports have two shapes: Codex models{} and modelBreakdowns[]. */
export function parseCcusage(raw: unknown, range: ConsumptionRange): ConsumptionRow[] {
  const report = object(raw);
  if (!Array.isArray(report.daily)) throw new Error('采集器未返回每日用量');
  const rows: ConsumptionRow[] = [];
  for (const value of report.daily) {
    const day = object(value), date = dateSchema.parse(day.date);
    if (date < range.since || date > range.until) continue;
    const dayTokens = tokens(day);
    let models: [string, ObjectValue][];
    if (day.models !== undefined) models = Object.entries(object(day.models)).map(([name, data]) => [name, object(data)]);
    else if (Array.isArray(day.modelBreakdowns)) models = day.modelBreakdowns.map(value => { const data = object(value); if (typeof data.modelName !== 'string') throw new Error('模型名称缺失'); return [data.modelName, data]; });
    else models = [];
    if (!models.length && dayTokens.input + dayTokens.output > 0) {
      rows.push({ date, model: '未记录模型', inferredModel: true, ...dayTokens });
      continue;
    }
    const summed = emptyTokens();
    for (const [model, data] of models) {
      const row = consumptionRowSchema.parse({ date, model, inferredModel: data.isFallback === true, ...tokens(data) });
      rows.push(row); addTokens(summed, row);
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (summed[key] !== dayTokens[key]) throw new Error('模型明细与每日合计不一致');
  }
  return rows;
}

export async function runCcusage(source: Exclude<SourceId, 'antigravity'>, range: ConsumptionRange, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  const args = [source, 'daily', '--json', '--offline', '--no-cost', '--no-color', '--config', backend.config, '--since', range.since, '--until', range.until, '--timezone', range.timezone];
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(backend.binary, args, { signal, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' } }, (error, stdout, stderr) => {
      if (error) {
        // Never expose raw logs, credential paths or transcript fragments to the client.
        const code = (error as NodeJS.ErrnoException).code;
        reject(new Error(code === 'ENOENT' ? '采集器文件缺失，请重新安装插件' : error.killed ? '读取超时，请稍后重试' : '本机用量读取失败，请检查数据目录和读取权限'));
      } else resolve({ stdout, stderr });
    });
  });
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { throw new Error('采集器未返回有效用量数据'); }
  return { rows: parseCcusage(json, range), message: stderr.trim() ? '部分记录可能未被采集，请检查本机 CLI 记录是否完整' : null };
}
