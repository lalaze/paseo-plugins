import { QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { PaseoApi } from '@getpaseo/client';

export function createUsageQuery(paseo: PaseoApi) {
  const client = new QueryClient();
  const options = queryOptions({
    queryKey: ['provider-usage'],
    queryFn: () => paseo.providers.listUsage(),
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
