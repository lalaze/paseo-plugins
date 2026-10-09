import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { PaseoApi } from '@getpaseo/client';
import type { AntigravityQuotaSnapshot } from '../shared/antigravity-quota';
import { findUsage, hasQuota, dataAge, type Usage, type UsageResult } from '../shared/usage';
import { ui } from '../shared/i18n';

export function createUsageQuery(paseo: PaseoApi, readAntigravity?: () => Promise<AntigravityQuotaSnapshot>) {
  const client = new QueryClient();
  let lastKnown: { usage: Usage; fetchedAt: string } | null = null;
  const options = queryOptions({
    queryKey: ['provider-usage'],
    queryFn: async (): Promise<UsageResult> => {
      const result = await paseo.providers.listUsage();
      const native = findUsage(result.providers, 'antigravity');
      if (hasQuota(native)) {
        lastKnown = { usage: native!, fetchedAt: result.fetchedAt };
        return result;
      }
      if (!readAntigravity) return result;
      let refreshing = false;
      let stale = true;
      try {
        const quota = await readAntigravity();
        refreshing = quota.refreshing ?? false;
        stale = quota.stale ?? false;
        // A stale server snapshot must not replace a newer native reading.
        if (quota.windows.length && (!stale || !lastKnown || quota.fetchedAt >= lastKnown.fetchedAt)) {
          lastKnown = { fetchedAt: quota.fetchedAt, usage: { providerId: 'antigravity', displayName: 'Antigravity', status: 'available', planLabel: null, windows: quota.windows, balances: [], details: [], error: null } };
        }
        if (!quota.windows.length) stale = true;
      } catch { /* Keep quota from the previous successful native or RPC read. */ }
      if (!lastKnown && !refreshing && !native) return result;
      const official: Usage = {
        ...(lastKnown?.usage ?? { providerId: 'antigravity', displayName: 'Antigravity', status: 'unavailable', planLabel: null, windows: [], balances: [], details: [], error: null }),
        quotaStale: stale, quotaRefreshing: refreshing,
        details: [
          ...(lastKnown?.usage.details ?? []).filter(detail => detail.id !== 'agy-quota-freshness'),
          ...(stale ? [{ id: 'agy-quota-freshness', label: ui('Quota update', '额度更新'), value: lastKnown
            ? ui(`Showing previous quota · ${dataAge(lastKnown.fetchedAt)}`, `保留上次额度 · ${dataAge(lastKnown.fetchedAt)}`)
            : ui('No successful quota read yet', '尚未成功读取额度') }] : []),
        ],
      };
      const index = result.providers.findIndex(provider => provider.providerId === official.providerId);
      const providers: Usage[] = [...result.providers];
      if (index < 0) providers.push(official);
      else providers[index] = official;
      const fetchedAt = lastKnown && lastKnown.fetchedAt < result.fetchedAt ? lastKnown.fetchedAt : result.fetchedAt;
      return { ...result, providers, fetchedAt };
    },
    staleTime: 60000,
    refetchInterval: query => query.state.data?.providers.some(provider => provider.quotaRefreshing) ? 1500 : 60000,
    retry: 1,
  });
  return { client, options };
}
export type UsageQuery = ReturnType<typeof createUsageQuery>;
export function useUsage(query: UsageQuery) {
  return useQuery(query.options, query.client);
}
