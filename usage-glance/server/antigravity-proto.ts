// Protobuf field layout and identity merging adapted from ccusage's Antigravity
// adapter, commit 0d220e060669c5e5b6eccfa8b64cc6f0e3539fcc (MIT).
// See THIRD-PARTY-NOTICES.md. Only accounting metadata is decoded.
type Field = { number: number; value: bigint | Uint8Array | null };
function fields(blob: Uint8Array): Field[] {
  if (!(blob instanceof Uint8Array) || blob.length > 32 * 1024 * 1024) throw new Error('Antigravity 元数据格式不兼容');
  let offset = 0;
  const read = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= blob.length) throw new Error('Antigravity 元数据不完整');
      const byte = blob[offset++];
      if (i === 9 && byte > 1) throw new Error('Antigravity 数值溢出');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Antigravity 数值溢出');
  };
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > blob.length) throw new Error('Antigravity 元数据不完整');
    const value = blob.subarray(offset, offset + length); offset += length; return value;
  };
  const result: Field[] = [];
  while (offset < blob.length) {
    const tag = read(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 536870911 || result.length > 100000) throw new Error('Antigravity 元数据格式不兼容');
    if (wire === 0) result.push({ number, value: read() });
    else if (wire === 2) result.push({ number, value: take(Number(read())) });
    else if (wire === 1 || wire === 5) { take(wire === 1 ? 8 : 4); result.push({ number, value: null }); }
    else throw new Error('Antigravity 元数据格式不兼容');
  }
  return result;
}
function bytes(values: Field[], number: number): Uint8Array | undefined {
  const value = values.find(field => field.number === number && field.value instanceof Uint8Array)?.value;
  return value instanceof Uint8Array ? value : undefined;
}
function integer(values: Field[], number: number): number {
  const value = values.findLast(field => field.number === number && typeof field.value === 'bigint')?.value ?? 0n;
  if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Antigravity token 数超出范围');
  return Number(value);
}
function text(values: Field[], number: number): string | undefined {
  const value = bytes(values, number);
  if (!value) return;
  const result = new TextDecoder('utf-8', { fatal: true }).decode(value).trim();
  if (result.length > 1024) throw new Error('Antigravity 标识格式不兼容');
  return result || undefined;
}
function timestamp(blob?: Uint8Array): number | undefined {
  if (!blob) return;
  const values = fields(blob), seconds = integer(values, 1), nanos = integer(values, 2);
  const ms = seconds * 1000 + Math.floor(nanos / 1000000);
  return seconds > 0 && nanos < 1e9 && Number.isSafeInteger(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
}
const modelIds: Record<number, string> = { 246: 'gemini-2.5-pro', 312: 'gemini-2.5-flash', 313: 'gemini-2.5-flash-thinking', 329: 'gemini-2.5-flash-thinking', 330: 'gemini-2.5-flash-lite', 281: 'claude-4-sonnet', 282: 'claude-4-sonnet', 290: 'claude-4-opus', 291: 'claude-4-opus', 333: 'claude-4.5-sonnet', 334: 'claude-4.5-sonnet', 340: 'claude-4.5-haiku', 341: 'claude-4.5-haiku', 342: 'gpt-oss-120b-medium', 1026: 'claude-opus-4-6', 1035: 'claude-sonnet-4-6', 1036: 'gemini-3.1-pro', 1037: 'gemini-3.1-pro', 1016: 'gemini-3.1-pro', 1018: 'gemini-3-flash-preview', 1084: 'gemini-3-flash-preview', 1047: 'gemini-3-flash-preview' };
function modelName(name?: string, id?: number): string | undefined {
  // Preserve source labels. Do not map moving model aliases to a guessed version.
  return name?.slice(0, 256) || (id ? modelIds[id] ?? `antigravity-model-${id}` : undefined);
}
export type AgyUsage = { fresh: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; model?: string; identities: string[] };
export type AgyMetadata = { model?: string; time?: number; usages: AgyUsage[] };
function usage(blob: Uint8Array): AgyUsage {
  const values = fields(blob), reasoning = integer(values, 9);
  const output = Math.max(integer(values, 3), integer(values, 10) + reasoning);
  const fresh = integer(values, 2), cacheWrite = integer(values, 4), cacheRead = integer(values, 5);
  if (!Number.isSafeInteger(fresh + cacheWrite + cacheRead + output)) throw new Error('Antigravity token 数超出范围');
  return { fresh, output, cacheWrite, cacheRead, reasoning, model: modelName(undefined, integer(values, 1)), identities: [[11, 'response'], [12, 'provider'], [7, 'message']].flatMap(([key, prefix]) => { const id = text(values, Number(key)); return id ? [`${prefix}:${id}`] : []; }) };
}
function usages(values: Field[], main: number, retry: number): AgyUsage[] {
  const mainBlob = bytes(values, main);
  const result = mainBlob ? [usage(mainBlob)] : [];
  for (const field of values) if (field.number === retry && field.value instanceof Uint8Array) {
    const retryBlob = bytes(fields(field.value), 2);
    if (retryBlob) result.push(usage(retryBlob));
  }
  return result.filter(value => value.fresh + value.cacheRead + value.cacheWrite + value.output > 0);
}
export function generationMetadata(blob: Uint8Array): AgyMetadata {
  const chat = bytes(fields(blob), 1);
  if (!chat) throw new Error('Antigravity 生成记录格式不兼容');
  const values = fields(chat), info = bytes(values, 9);
  return { model: modelName(text(values, 19) ?? text(values, 21), integer(values, 3)), time: timestamp(info ? bytes(fields(info), 4) : undefined), usages: usages(values, 4, 17) };
}
export function stepMetadata(blob: Uint8Array): AgyMetadata {
  const values = fields(blob), info = bytes(values, 24), model = info ? fields(info) : [];
  return { model: modelName(text(model, 12) ?? text(model, 8), integer(model, 1)), time: timestamp(bytes(values, 8) ?? bytes(values, 1)), usages: usages(values, 9, 28) };
}
export function trajectoryTimestamp(blob: Uint8Array): number | undefined { return timestamp(bytes(fields(blob), 2)); }

export type AgyEvent = AgyUsage & { time?: number; timeRank: number; model: string };
/** The same call appears in steps, generation metadata, retries, and DB copies. */
export function dedupeAgy(events: AgyEvent[]): AgyEvent[] {
  const slots: (AgyEvent | null)[] = [], identities = new Map<string, number>();
  const merge = (target: AgyEvent, other: AgyEvent) => {
    for (const key of ['fresh', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const) target[key] = Math.max(target[key], other[key]);
    target.output = Math.max(target.output, target.reasoning);
    if (target.model === '未记录模型' || /^antigravity-model-/.test(target.model)) target.model = other.model;
    if (other.time !== undefined && (target.time === undefined || other.timeRank > target.timeRank || (other.timeRank === target.timeRank && other.time < target.time))) { target.time = other.time; target.timeRank = other.timeRank; }
    target.identities = [...new Set([...target.identities, ...other.identities])];
  };
  for (const input of events) {
    const event = { ...input, identities: [...input.identities] };
    const matches = [...new Set(event.identities.flatMap(id => identities.has(id) ? [identities.get(id)!] : []))].sort((a, b) => a - b);
    const targetIndex = matches[0] ?? slots.length;
    if (!matches.length) slots.push(event);
    else {
      const target = slots[targetIndex]!;
      for (const index of matches.slice(1)) { if (slots[index]) merge(target, slots[index]!); slots[index] = null; }
      merge(target, event);
    }
    for (const id of slots[targetIndex]!.identities) identities.set(id, targetIndex);
  }
  return slots.filter((value): value is AgyEvent => value !== null);
}
