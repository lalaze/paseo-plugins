import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { PaseoApi } from '@getpaseo/client';
import type { AntigravityQuotaSnapshot } from '../shared/antigravity-quota';
import { findUsage, hasQuota, type Usage } from '../shared/usage';

export function createUsageQuery(paseo: PaseoApi, readAntigravity?: () => Promise<AntigravityQuotaSnapshot>) {
  const client = new QueryClient();
  const options = queryOptions({
    queryKey: ['provider-usage'],
    queryFn: async () => {
      const result = await paseo.providers.listUsage();
      if (!readAntigravity || hasQuota(findUsage(result.providers, 'antigravity'))) return result;
      try {
        const quota = await readAntigravity();
        if (!quota.windows.length) return result;
        const official: Usage = { providerId: 'antigravity', displayName: 'Antigravity', status: 'available', planLabel: null, windows: quota.windows, balances: [], details: [], error: null };
        const index = result.providers.findIndex(provider => provider.providerId === 'antigravity');
        const providers = [...result.providers];
        if (index < 0) providers.push(official);
        else providers[index] = official;
        return { ...result, providers, fetchedAt: quota.fetchedAt < result.fetchedAt ? quota.fetchedAt : result.fetchedAt };
      } catch { return result; }
    },
    staleTime: 60000,
    refetchInterval: 60000,
    retry: 1,
  });
  return { client, options };
}
export type UsageQuery = ReturnType<typeof createUsageQuery>;
export function useUsage(query: UsageQuery) {
  return useQuery(query.options, query.client);
}
