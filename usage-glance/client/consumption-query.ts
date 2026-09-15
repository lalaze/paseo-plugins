import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import type { PaseoApi } from '@getpaseo/client';
import { enabledConsumptionSources, unsupportedConsumptionProviders, readConsumption, type ConsumptionRange, type ConsumptionReport } from '../shared/consumption';

export function createConsumptionQuery(client: QueryClient, rpc: PluginClientContext['rpc'], providers: Pick<PaseoApi['providers'], 'subscribe'>) {
  let revision = 0, previous: string | undefined, closed = false;
  const unsubscribe = providers.subscribe(snapshot => {
    if (closed) return;
    const sources = enabledConsumptionSources(snapshot.entries), unsupportedProviders = unsupportedConsumptionProviders(snapshot.entries);
    const selection = JSON.stringify({ sources, unsupportedProviders });
    if (selection === previous) return;
    previous = selection; const current = ++revision;
    // Cancel in-flight queries before removing disabled sources from every cached range.
    // Refresh responses started before the switch cannot put the old totals back.
    void client.cancelQueries({ queryKey: ['token-consumption'] }).then(() => {
      if (closed || current !== revision) return;
      client.setQueriesData<ConsumptionReport>({ queryKey: ['token-consumption'] }, report => {
        if (!report) return report;
        const visible = report.sources.filter(source => sources.includes(source.source));
        return { ...report, sources: visible, unsupportedProviders, scanning: report.scanning && visible.length > 0 };
      });
      return client.invalidateQueries({ queryKey: ['token-consumption'] });
    });
  });
  return {
    client,
    dispose() { closed = true; unsubscribe(); },
    options: (range: ConsumptionRange) => queryOptions<ConsumptionReport>({
      queryKey: ['token-consumption', range] as const,
      queryFn: async ({ signal }) => {
        const report = await rpc(readConsumption, { range, refresh: false });
        if (signal.aborted) throw new Error('读取已取消');
        return report;
      },
      staleTime: 1000,
      gcTime: 5 * 60000,
      refetchInterval: query => query.state.data?.scanning ? 1500 : 60000,
      retry: 1,
    }),
    async refresh(range: ConsumptionRange) {
      const started = revision;
      const report = await rpc(readConsumption, { range, refresh: true });
      if (!closed && started === revision) client.setQueryData(['token-consumption', range], report);
    },
  };
}
export type ConsumptionQuery = ReturnType<typeof createConsumptionQuery>;
export function useConsumption(query: ConsumptionQuery, range: ConsumptionRange) { return useQuery(query.options(range), query.client); }
