import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type Tokens, type WorkspaceIdentity } from '../shared/consumption';

/** Paseo's DSH provider home; its launcher starts DSH with `DSH_HOME` pointing here. */
export function deepseekSessionsRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME || env.DEEPSEEK_HARNESS_HOME || join(home, '.local', 'share', 'paseo', 'providers', 'deepseek-harness', 'home');
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
/** DSH provider usage buckets are disjoint; `totalTokens` is derived and never added. */
function tokens(raw: unknown): Tokens {
  const usage = object(raw);
  const input = count(usage.inputTokens), cacheRead = count(usage.cacheReadTokens ?? 0), cacheWrite = count(usage.cacheWriteTokens ?? 0);
  const output = count(usage.outputTokens);
  if (!Number.isSafeInteger(input + cacheRead + cacheWrite + output)) throw new Error('用量记录的 token 合计不一致');
  // Buckets are disjoint, so the reported total is exactly input + cache + output.
  if (usage.totalTokens !== undefined && count(usage.totalTokens) !== input + output + cacheRead + cacheWrite) throw new Error('用量记录的 token 合计不一致');
  // Callers see input including cache, matching the other sources.
  return { input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite, reasoning: null };
}
function empty(value: Tokens): boolean {
  return value.input === 0 && value.output === 0;
}
function modelOf(value: unknown): string | null {
  const config = value && typeof value === 'object' ? (value as ObjectValue).config : undefined;
  const model = config && typeof config === 'object' ? (config as ObjectValue).model : undefined;
  return typeof model === 'string' && model.trim() ? model : null;
}

const ZSTD_MAGIC = 0xfd2fb528;
/**
 * DSH appends one checksummed Zstandard frame per durable batch. Decode only
 * complete frames, as the backend does: a torn final frame is skipped, not fatal.
 */
function zstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const start = offset;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('Zstandard 帧无效');
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) throw new Error('Zstandard 帧无效');
    const contentSizeFlag = descriptor >>> 6, singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3], contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let complete = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0, blockType = (blockHeader >>> 1) & 3, blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('Zstandard 帧无效');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) { complete = true; break; }
    }
    if (!complete) break;
    if (descriptor & 0x04) { if (buffer.length - offset < 4) break; offset += 4; }
    frames.push(buffer.subarray(start, offset));
  }
  return frames;
}
const decompress = promisify(zstdDecompress);
async function* readLog(path: string, signal: AbortSignal): AsyncGenerator<string> {
  if (path.endsWith('.jsonl.zstd')) {
    for (const frame of zstdFrames(await readFile(path, { signal }))) {
      checkSignal(signal);
      let plaintext: string;
      try { plaintext = (await decompress(frame)).toString('utf8'); }
      catch { throw new Error('Zstandard 帧已损坏'); }
      for (const line of plaintext.split('\n')) if (line.trim()) yield line;
    }
    return;
  }
  const input = createReadStream(path, { encoding: 'utf8', signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) yield line; }
  finally { lines.close(); input.destroy(); }
}

/** The usage sample DSH replaces within a step: the last usage chunk, or the settled message usage. */
function usageOf(entry: ObjectValue): unknown {
  const data = object(entry.data);
  if (entry.type === 'assistant/message') return data.usage;
  if (entry.type !== 'assistant/attempt' || !Array.isArray(data.stream)) return undefined;
  let usage: unknown;
  for (const value of data.stream) {
    const chunk = value && typeof value === 'object' ? (value as ObjectValue).chunk : undefined;
    if (chunk && typeof chunk === 'object' && (chunk as ObjectValue).type === 'usage') usage = (chunk as ObjectValue).usage;
  }
  return usage;
}
type Sample = Tokens & { identity: string; date: string; model: string; inferredModel: boolean; workspace?: WorkspaceIdentity };

/**
 * Read DSH's append-only session logs, folding usage per step exactly as DSH's
 * own token meter does: retries open a new replacement scope, later samples in
 * one scope replace earlier ones, and a step reports no usage on failure.
 */
export async function runDeepseek(range: ConsumptionRange, signal: AbortSignal, root = deepseekSessionsRoot(), resolveWorkspace?: (id?: string, cwd?: string) => WorkspaceIdentity | undefined): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  const rows = new Map<string, ConsumptionRow>(), seen = new Map<string, Sample>();
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
      if (!item.isFile() || !/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(item.name)) continue;
      files++;
      let header: ObjectValue | undefined, model: string | undefined, workspace: WorkspaceIdentity | undefined, parsed = 0, lineNumber = 0;
      let last: { turn: unknown; step: unknown; tokens: Tokens } | undefined;
      const sessionSamples: Sample[] = [];
      try {
        for await (const line of readLog(path, signal)) {
          checkSignal(signal);
          if (++lineNumber % 256 === 0) await setImmediate();
          let entry: ObjectValue;
          try { entry = object(JSON.parse(line)); } catch { warnings++; continue; }
          parsed++;
          try {
            if (!header) {
              // Only the current generation holds live data; retired generations are migrated copies.
              if (entry.type !== 'session' || Number(entry.version ?? 0) !== 4 || !/\.v4\.jsonl(?:\.zstd)?$/.test(item.name)) { warnings++; break; }
              header = entry;
              // Directories are escaped ids; the header cwd is authoritative for plaintext logs.
              if (typeof entry.id !== 'string') { warnings++; break; }
              workspace = resolveWorkspace?.(entry.id, typeof entry.cwd === 'string' ? entry.cwd : undefined);
              readable++;
              continue;
            }
            if (entry.type === 'llm/retry-started') {
              const data = object(entry.data);
              if (last && last.turn === data.turn && last.step === data.step) last = undefined;
              continue;
            }
            if (entry.type === 'request/header') { model = modelOf(object(entry.data).header) ?? model; continue; }
            if (entry.type !== 'assistant/message' && entry.type !== 'assistant/attempt') continue;
            const sample = usageOf(entry), data = object(entry.data);
            if (sample === undefined || sample === null) continue;
            const usage = tokens(sample), previous = last && last.turn === data.turn && last.step === data.step ? last.tokens : undefined;
            last = { turn: data.turn, step: data.step, tokens: usage };
            const delta: Tokens = {
              input: usage.input - (previous?.input ?? 0), output: usage.output - (previous?.output ?? 0),
              cacheRead: usage.cacheRead - (previous?.cacheRead ?? 0), cacheWrite: usage.cacheWrite - (previous?.cacheWrite ?? 0), reasoning: null,
            };
            if (empty(delta)) continue;
            if (delta.input < 0 || delta.output < 0 || delta.cacheRead < 0 || delta.cacheWrite < 0) throw new Error('用量记录回退');
            const time = typeof entry.time === 'number' ? entry.time : NaN;
            if (!Number.isFinite(new Date(time).getTime())) throw new Error('用量记录缺少有效日期');
            const date = dateInZone(new Date(time), range.timezone);
            const name = model ?? 'Unrecorded model';
            if (name.length > 256) throw new Error('模型名称过长');
            // Resumed forks replay a source step in a new session; the step identifies it within one log.
            const identity = `${String(data.turn)}:${String(data.step)}:${createHash('sha256').update(JSON.stringify(delta)).digest('hex').slice(0, 16)}`;
            sessionSamples.push({ ...delta, identity, date, model: name, inferredModel: name === 'Unrecorded model', ...(workspace ? { workspace } : {}) });
          } catch { warnings++; }
        }
        if (!header && !parsed) warnings++;
      } catch { checkSignal(signal); warnings++; }
      if (header && typeof header.id === 'string') for (const sample of sessionSamples) {
        const key = `${header.id}:${sample.identity}`;
        const existing = seen.get(key);
        // Copies in different workspaces do not establish which spent the tokens.
        if (existing) { if (existing.workspace?.id !== sample.workspace?.id) delete existing.workspace; }
        else seen.set(key, sample);
      }
      await setImmediate();
    }
  }
  checkSignal(signal);
  if (!readable && (files || warnings)) throw new Error('本机 DeepSeek Harness 用量记录无法读取，请检查格式和读取权限');
  const inRange = (date: string) => date >= range.since && date <= range.until;
  for (const { identity: _, ...usage } of seen.values()) {
    if (!inRange(usage.date)) continue;
    const key = JSON.stringify([usage.date, usage.model, usage.workspace?.id]);
    let row = rows.get(key);
    if (!row) { row = { ...usage, ...emptyTokens() }; rows.set(key, row); }
    addTokens(row, usage);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)),
    message: warnings ? `${warnings} 个 DeepSeek Harness 文件或记录未能读取，统计可能不完整` : null,
  };
}
