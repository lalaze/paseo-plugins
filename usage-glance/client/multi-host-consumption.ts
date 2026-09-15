import { QueryClient, queryOptions } from '@tanstack/react-query';
import { totalTokens, type ConsumptionRange, type ConsumptionReport } from '../shared/consumption';
import { type HostEntry, type HostRegistry, rangeKey } from './hosts';
import type { ConsumptionQuery } from './consumption-query';

export function combineHostConsumption(hosts: readonly HostEntry[], range: ConsumptionRange): ConsumptionReport {
  const key = rangeKey(range);
  const report: ConsumptionReport = { range, scanning: false, sources: [], unsupportedProviders: [], hosts: [] };
  for (const host of hosts) {
    const cached = host.reports.get(key), identity = { id: host.id, label: host.label };
    const error = host.errors.has(key);
    const loading = host.online && !error && (host.pending.has(key) || cached?.scanning === true || !cached);
    const status = !host.online ? 'offline' : error ? 'error' : loading ? 'loading' : 'ready';
    report.scanning ||= loading;
    const updatedAt = cached?.sources.map(source => source.updatedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    const hasReading = cached && (cached.sources.length === 0 ? !cached.scanning : cached.sources.some(source => source.rows.length > 0 || source.status === 'ready' || source.status === 'empty'));
    report.hosts!.push({ ...identity, status, updatedAt, total: hasReading ? cached.sources.reduce((sum, source) => sum + source.rows.reduce((sum, row) => sum + totalTokens(row), 0), 0) : null });
    if (!cached) continue;
    for (const source of cached.sources) report.sources.push({ ...source, host: identity });
    for (const provider of cached.unsupportedProviders ?? []) report.unsupportedProviders!.push({ ...provider, host: identity });
  }
  return report;
}

/** Each host updates the panel independently; a slow/offline host cannot block another. */
export function createMultiHostConsumption(registry: HostRegistry, selected: string | null): ConsumptionQuery & { mount(): void } {
  const client = new QueryClient();
  let closed = false;
  const hosts = () => registry.getSnapshot().filter(host => selected === null || host.id === selected);
  const report = (range: ConsumptionRange) => combineHostConsumption(hosts(), range);
  let previousHosts = hosts();
  let unsubscribe: (() => void) | undefined;
  const update = () => {
    if (closed) return;
    const currentHosts = hosts();
    const changed = currentHosts.length !== previousHosts.length || currentHosts.some((host, index) => host.id !== previousHosts[index]?.id || host.runtime !== previousHosts[index]?.runtime);
    previousHosts = currentHosts;
    client.setQueriesData<ConsumptionReport>({ queryKey: ['token-consumption'] }, previous => previous ? report(previous.range) : undefined);
    if (changed) void client.invalidateQueries({ queryKey: ['token-consumption'] });
  };
  const start = (range: ConsumptionRange, force = false) => {
    for (const host of hosts()) void registry.ensure(host.id, range, force);
    return report(range);
  };
  return {
    client,
    mount() { if (unsubscribe) return; closed = false; client.mount(); unsubscribe = registry.subscribe(update); update(); },
    options: range => queryOptions<ConsumptionReport>({
      queryKey: ['token-consumption', range],
      queryFn: () => start(range),
      staleTime: 1000,
      gcTime: 5 * 60000,
      refetchInterval: query => query.state.data?.scanning ? 1500 : 60000,
      retry: false,
    }),
    async refresh(range) { client.setQueryData(['token-consumption', range], start(range, true)); },
    dispose() { closed = true; unsubscribe?.(); unsubscribe = undefined; client.unmount(); client.clear(); },
  };
}
