import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { hostIdentitySchema, type HostIdentity } from './hosts';

export const sourceIds = ['codex', 'claude', 'kimi', 'grok', 'antigravity', 'pi'] as const;
export type SourceId = typeof sourceIds[number];
export const sourceNames: Record<SourceId, string> = { codex: 'Codex', claude: 'Claude Code', kimi: 'Kimi', grok: 'Grok', antigravity: 'Antigravity', pi: 'Pi' };
const providerSources = new Map<string, SourceId>([
  ...sourceIds.map(source => [source, source] as const),
  ['antigravity-acp', 'antigravity'], ['antigravity-hub', 'antigravity'],
]);
/** Enablement comes from Paseo's host catalog, independently of login/readiness. */
export function enabledConsumptionSources(providers: readonly { provider: string; enabled: boolean }[]): SourceId[] {
  const selected = new Set(providers.filter(provider => provider.enabled).map(provider => providerSources.get(provider.provider)));
  return sourceIds.filter(source => selected.has(source));
}
export function unsupportedConsumptionProviders(providers: readonly { provider: string; enabled: boolean; label?: string }[]) {
  return providers.filter(provider => provider.enabled && !providerSources.has(provider.provider)).map(provider => ({ id: provider.provider, label: provider.label ?? provider.provider }));
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokensSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, reasoning: count.nullable() });
export type Tokens = z.infer<typeof tokensSchema>;
export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
/** Input includes cache, output includes reasoning. Subtotals must never be added twice. */
export const totalTokens = (tokens: Tokens) => tokens.input + tokens.output;
export function addTokens(target: Tokens, value: Tokens) {
  target.input += value.input; target.output += value.output;
  target.cacheRead += value.cacheRead; target.cacheWrite += value.cacheWrite;
  target.reasoning = target.reasoning === null || value.reasoning === null ? null : target.reasoning + value.reasoning;
}

export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export const dateSchema = z.string().refine(validDate, '请输入有效日期（YYYY-MM-DD）');
export const rangeSchema = z.object({
  since: dateSchema,
  until: dateSchema,
  timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '时区无效'),
}).refine(value => value.since <= value.until, '开始日期不能晚于结束日期')
  .refine(value => Date.parse(value.until) - Date.parse(value.since) < 366 * 86400000, '一次最多查看 366 天');
export type ConsumptionRange = z.infer<typeof rangeSchema>;
export const consumptionRowSchema = tokensSchema.extend({ date: dateSchema, model: z.string().max(256), inferredModel: z.boolean() });
export type ConsumptionRow = z.infer<typeof consumptionRowSchema>;
export const sourceReportSchema = z.object({
  source: z.enum(sourceIds), status: z.enum(['loading', 'ready', 'empty', 'partial', 'error']),
  updatedAt: z.string().nullable(), rows: z.array(consumptionRowSchema), message: z.string().nullable(),
  host: hostIdentitySchema.optional(),
});
export type SourceReport = z.infer<typeof sourceReportSchema>;
export const consumptionReportSchema = z.object({
  range: rangeSchema, scanning: z.boolean(), sources: z.array(sourceReportSchema),
  unsupportedProviders: z.array(z.object({ id: z.string(), label: z.string(), host: hostIdentitySchema.optional() })).optional(),
  hosts: z.array(hostIdentitySchema.extend({ status: z.enum(['ready', 'loading', 'offline', 'error']), updatedAt: z.string().nullable(), total: count.nullable() })).optional(),
});
export type ConsumptionReport = z.infer<typeof consumptionReportSchema>;
export const readConsumption = defineRpc({ name: 'read-consumption', input: z.object({ range: rangeSchema, refresh: z.boolean().default(false) }), output: consumptionReportSchema });

export function dateInZone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
export function presetRange(preset: 'today' | 'week' | 'month', timezone: string, now = new Date()): ConsumptionRange {
  const until = dateInZone(now, timezone);
  const since = preset === 'today' ? until : preset === 'month' ? `${until.slice(0, 7)}-01` : new Date(Date.parse(`${until}T12:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  return { since, until, timezone };
}

/** Model maker is distinct from the CLI and from a reseller or proxy channel. */
export function modelVendor(model: string, source: SourceId): string {
  const name = model.toLowerCase().replace(/^(openrouter|azure|bedrock|vertex_ai|xai|x-ai|openai|anthropic|google|moonshot|zai)\//, '');
  if (/^(gpt[ -]|o[134](?:-|$)|chatgpt|codex)/.test(name)) return 'OpenAI';
  if (/^claude[ -]/.test(name)) return 'Anthropic';
  if (/^gemini[ -]/.test(name)) return 'Google';
  if (/^grok[ -]/.test(name)) return 'xAI';
  if (/^(kimi|moonshot)/.test(name) || (source === 'kimi' && /^k\d(?:[.-]|$)/.test(name))) return '月之暗面';
  if (/^glm[ -]/.test(name)) return '智谱';
  if (/^deepseek[ -]/.test(name)) return 'DeepSeek';
  if (/^qwen[ -]|^qwen\d/.test(name)) return '阿里云';
  if (/^minimax[ -]/.test(name)) return 'MiniMax';
  return '未识别供应商';
}
export type ModelTotal = Tokens & { model: string; source: SourceId; inferredModel: boolean; host?: HostIdentity };
export type ConsumptionGroup = Tokens & { id: string; label: string; models: ModelTotal[] };
export type ConsumptionGrouping = 'vendor' | 'source' | 'model' | 'host';
export function groupConsumption(sources: SourceReport[], by: ConsumptionGrouping): ConsumptionGroup[] {
  const groups = new Map<string, ConsumptionGroup>();
  for (const report of sources) for (const row of report.rows) {
    const label = by === 'host' ? report.host?.label ?? '本机' : by === 'source' ? sourceNames[report.source] : by === 'model' ? row.model : modelVendor(row.model, report.source);
    const id = by === 'host' ? report.host?.id ?? 'local' : label;
    let group = groups.get(id);
    if (!group) { group = { ...emptyTokens(), id, label, models: [] }; groups.set(id, group); }
    addTokens(group, row);
    let model = group.models.find(value => value.source === report.source && value.model === row.model && value.host?.id === report.host?.id);
    if (!model) { model = { ...emptyTokens(), source: report.source, model: row.model, inferredModel: false, ...(report.host ? { host: report.host } : {}) }; group.models.push(model); }
    addTokens(model, row); model.inferredModel ||= row.inferredModel;
  }
  for (const group of groups.values()) group.models.sort((a, b) => totalTokens(b) - totalTokens(a));
  return [...groups.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
}
export function formatTokens(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
export function compactTokens(value: number): string {
  if (value > 0 && value < 10000) return '<0.01M';
  const divisor = value < 100000000 ? 1000000 : 100000000;
  return `${Number((value / divisor).toFixed(2))}${divisor === 1000000 ? 'M' : '亿'}`;
}
