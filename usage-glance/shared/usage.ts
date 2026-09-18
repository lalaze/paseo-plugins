import type { PaseoProviderUsageResult } from '@getpaseo/client';
import { ui, uiNumberLocale } from './i18n';

export type UsageResult = PaseoProviderUsageResult;
export type Usage = UsageResult['providers'][number];
export type UsageWindow = Usage['windows'][number];
export type UsageBalance = NonNullable<Usage['balances']>[number];
export type Tone = 'ok' | 'warning' | 'danger' | 'unknown';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const percent = (n: number) => Math.max(0, Math.min(100, n));

export function remaining(window: UsageWindow): number | null {
  if (finite(window.remainingPct)) return percent(window.remainingPct);
  if (finite(window.usedPct)) return percent(100 - window.usedPct);
  return null;
}

export function balanceRemaining(balance: UsageBalance): number | null {
  if (finite(balance.remaining)) return Math.max(0, balance.remaining);
  if (finite(balance.limit) && finite(balance.used)) return Math.max(0, balance.limit - balance.used);
  return null;
}

export function balancePercent(balance: UsageBalance): number | null {
  const value = balanceRemaining(balance);
  return value !== null && finite(balance.limit) && balance.limit > 0 ? percent(value / balance.limit * 100) : null;
}

export function tone(value: number | null): Tone {
  return value === null ? 'unknown' : value <= 10 ? 'danger' : value <= 25 ? 'warning' : 'ok';
}

export function formatPercent(value: number): string {
  // Do not turn a small positive balance into an apparent zero or 99.9 into full.
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value < 100 && value > 99.9) return '>99.9%';
  return `${Number(value.toFixed(1))}%`;
}

export function formatBalance(balance: UsageBalance): string {
  const value = balanceRemaining(balance);
  if (value === null) return ui('Unknown', '未知');
  if (balance.unit === 'usd') return `$${value.toFixed(2)}`;
  const unit = { credits: ui('credits', '积分'), requests: ui('requests', '次'), tokens: 'tokens' }[balance.unit];
  return `${value.toLocaleString(uiNumberLocale(), { maximumFractionDigits: 2 })} ${unit}`;
}

export function findUsage(providers: Usage[], provider: string): Usage | undefined {
  // Both locally configured Antigravity bridges use the same agy account reader.
  const id = provider === 'antigravity-hub' ? 'antigravity-acp' : provider;
  return providers.find(entry => entry.providerId === id);
}

export function modelWindows(usage: Usage, model?: string | null): UsageWindow[] {
  if (usage.providerId !== 'antigravity-acp' || !model) return usage.windows;
  const family = /gemini/i.test(model) ? /gemini/i : /claude|gpt/i.test(model) ? /claude|gpt/i : null;
  if (!family) return usage.windows;
  const matches = usage.windows.filter(window => family.test(window.label));
  return matches.length ? matches : usage.windows;
}

export function hasQuota(usage?: Usage): boolean {
  if (!usage || usage.status !== 'available') return false;
  return usage.windows.some(window => remaining(window) !== null)
    || (usage.balances ?? []).some(balance => balanceRemaining(balance) !== null);
}

export function summary(usage?: Usage, model?: string | null) {
  if (!usage || usage.status !== 'available') return { label: ui('Quota unavailable', '额度暂不可用'), tone: 'unknown' as Tone, remainingPct: null, detail: ui('No quota data is currently available for this provider', '当前供应商尚无可用额度数据') };
  const windows = modelWindows(usage, model);
  const metrics = [
    ...windows.map(window => ({ label: window.label, value: remaining(window) })),
    ...(usage.balances ?? []).map(balance => ({ label: balance.label, value: balancePercent(balance) })),
  ].filter((item): item is { label: string; value: number } => item.value !== null);
  if (metrics.length) {
    const lowest = metrics.reduce((a, b) => a.value <= b.value ? a : b);
    const qualifier = metrics.length > 1 ? ui('Lowest remaining', '最低剩余') : ui('Remaining', '剩余');
    return { label: `${qualifier} ${formatPercent(lowest.value)}`, tone: tone(lowest.value), remainingPct: lowest.value, detail: `${usage.displayName} · ${lowest.label} · ${ui('remaining', '剩余')} ${formatPercent(lowest.value)}` };
  }
  const balance = usage.balances?.find(item => balanceRemaining(item) !== null);
  if (balance) return { label: `${ui('Remaining', '剩余')} ${formatBalance(balance)}`, tone: balanceRemaining(balance) === 0 ? 'danger' as Tone : 'ok' as Tone, remainingPct: null, detail: `${usage.displayName} · ${balance.label}` };
  return { label: ui('Quota unknown', '额度未知'), tone: 'unknown' as Tone, remainingPct: null, detail: ui(`${usage.displayName} did not return a calculable remaining quota`, `${usage.displayName} 未返回可计算的剩余额度`) };
}

const aliases: Record<string, string> = { 'antigravity-acp': 'AGY', codex: 'Codex', kimi: 'Kimi', grok: 'Grok', claude: 'Claude', copilot: 'Copilot', cursor: 'Cursor', zai: 'GLM', minimax: 'MiniMax' };

export function providerShortName(usage: Usage): string {
  return aliases[usage.providerId] ?? Array.from(usage.displayName).slice(0, 6).join('');
}

function pinnedUsage(providers: Usage[], selectedId: string) {
  return findUsage(providers, selectedId) ?? providers.find(entry => entry.providerId === selectedId);
}

function pinnedHeader(usage: Usage) {
  const name = providerShortName(usage);
  if (usage.status !== 'available') {
    return {
      label: ui(`${name} unavailable`, `${name} 暂不可用`),
      tone: 'unknown' as Tone,
      detail: ui(`The header is pinned to ${usage.displayName}, whose quota is currently unavailable. Click to show the lowest remaining quota again or view all quotas.`, `顶栏固定显示 ${usage.displayName}，当前暂无可用额度。点击可改回最低剩余或查看全部额度`),
    };
  }
  const brief = summary(usage);
  return {
    label: brief.remainingPct !== null ? ui(`${name} ${formatPercent(brief.remainingPct)} left`, `${name} 余${formatPercent(brief.remainingPct)}`) : `${name} ${brief.label}`,
    tone: brief.tone,
    detail: ui(`The header is pinned to ${brief.detail}. Click to show the lowest remaining quota again or view all quotas.`, `顶栏固定显示 ${brief.detail}。点击可改回最低剩余或查看全部额度`),
  };
}

/** A single short header label fits Paseo's 160px button and remains meaningful outside chat. */
export function headerSummary(providers: Usage[], selectedId?: string | null) {
  const pinned = selectedId ? pinnedUsage(providers, selectedId) : undefined;
  if (pinned && hasQuota(pinned)) return pinnedHeader(pinned);
  const candidates = providers.map(usage => ({ usage, brief: summary(usage) }))
    .filter(item => item.brief.remainingPct !== null)
    .sort((a, b) => a.brief.remainingPct! - b.brief.remainingPct!);
  const lowest = candidates[0];
  if (!lowest) return { label: ui('Quota · View details', '额度 · 查看明细'), tone: 'unknown' as Tone, detail: ui('No percentage quotas are available for comparison. Click to view balances and details.', '尚无可比较的百分比额度，点击查看余额与明细') };
  const name = providerShortName(lowest.usage);
  return {
    label: ui(`${name} ${formatPercent(lowest.brief.remainingPct!)} left`, `${name} 余${formatPercent(lowest.brief.remainingPct!)}`),
    tone: lowest.brief.tone,
    detail: selectedId
      ? ui(`The selected provider has no data. Showing the lowest remaining quota: ${lowest.brief.detail}. Click to view all quotas.`, `已选择的供应商暂无数据，当前显示最低剩余：${lowest.brief.detail}。点击查看全部额度`)
      : ui(`Lowest of all available quotas: ${lowest.brief.detail}. Click to view all quotas.`, `所有可用额度中的最低剩余：${lowest.brief.detail}。点击查看全部额度`),
  };
}

export function resetLabel(value?: string | null, now = Date.now()): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const minutes = Math.ceil((Date.parse(value) - now) / 60000);
  if (minutes <= 0) return ui('Reset time reached; awaiting an update', '已到重置时间，等待更新');
  if (minutes < 60) return ui(`Resets in ${minutes} min`, `${minutes} 分钟后重置`);
  if (minutes < 1440) return ui(`Resets in ${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`, `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}后重置`);
  return ui(`Resets in ${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} hr`, `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后重置`);
}

export function dataAge(value?: string | null, now = Date.now()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return ui('Not updated yet', '尚未更新');
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  return minutes < 1 ? ui('Updated just now', '刚刚更新') : ui(`Updated ${minutes} min ago`, `${minutes} 分钟前更新`);
}

export function isStale(result?: UsageResult, now = Date.now()): boolean {
  return !!result && (!Number.isFinite(Date.parse(result.fetchedAt)) || now - Date.parse(result.fetchedAt) > 6 * 60000);
}
