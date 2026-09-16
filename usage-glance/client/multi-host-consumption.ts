import { QueryClient, queryOptions } from '@tanstack/react-query';
import { totalTokens, type ConsumptionRange, type ConsumptionReport } from '../shared/consumption';
import { cachedHostConsumption, type HostEntry, type HostRegistry, rangeKey } from './hosts';
import type { ConsumptionQuery } from './consumption-query';
import { hasConsumptionReading, projectConsumptionReport } from '../shared/consumption-cache';

export function combineHostConsumption(hosts: readonly HostEntry[], range: ConsumptionRange, exactRanges = false): ConsumptionReport {
  const report: ConsumptionReport = { range, scanning: false, sources: [], unsupportedProviders: [], hosts: [] };
  for (const host of hosts) {
    const stored = cachedHostConsumption(host, range, exactRanges), cached = stored && projectConsumptionReport(stored, range), identity = { id: host.id, label: host.label };
    const key = rangeKey(stored?.range ?? range);
    const error = host.errors.has(key);
    const loading = host.online && !error && (host.pending.has(key) || cached?.scanning === true || !cached);
    const hasReading = hasConsumptionReading(cached);
    const status = !host.online ? 'offline' : error ? 'error' : loading && !hasReading ? 'loading' : 'ready';
    report.scanning ||= loading;
    const updatedAt = cached?.sources.map(source => source.updatedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    report.hosts!.push({ ...identity, status, updatedAt, total: hasReading && cached ? cached.sources.reduce((sum, source) => sum + source.rows.reduce((sum, row) => sum + totalTokens(row), 0), 0) : null });
    if (!cached) continue;
    for (const source of cached.sources) report.sources.push({ ...source, host: identity });
    for (const provider of cached.unsupportedProviders ?? []) report.unsupportedProviders!.push({ ...provider, host: identity });
  }
  return report;
}

/** Each host updates the panel independently; a slow/offline host cannot block another. */
export function createMultiHostConsumption(registry: HostRegistry, selected: string | null, sharedClient?: QueryClient): ConsumptionQuery & { mount(): void; select(hostId: string | null): void } {
  const client = sharedClient ?? new QueryClient();
  const queryKey = registry.exactRanges ? 'workspace-consumption' : 'token-consumption';
  let closed = false;
  let selectedHost = selected;
  const hosts = () => registry.getSnapshot().filter(host => selectedHost === null || host.id === selectedHost);
  const report = (range: ConsumptionRange) => combineHostConsumption(hosts(), range, registry.exactRanges);
  let previousHosts = hosts();
  let unsubscribe: (() => void) | undefined;
  const update = () => {
    if (closed) return;
    const currentHosts = hosts();
    const changed = currentHosts.length !== previousHosts.length || currentHosts.some((host, index) => host.id !== previousHosts[index]?.id || host.runtime !== previousHosts[index]?.runtime);
    previousHosts = currentHosts;
    client.setQueriesData<ConsumptionReport>({ queryKey: [queryKey] }, previous => previous ? report(previous.range) : undefined);
    if (changed) void client.invalidateQueries({ queryKey: [queryKey] });
  };
  const start = (range: ConsumptionRange, force = false) => {
    for (const host of hosts()) void registry.ensure(host.id, range, force);
    return report(range);
  };
  return {
    client,
    select(hostId) { if (hostId === selectedHost) return; selectedHost = hostId; update(); },
    mount() { if (unsubscribe) return; closed = false; client.mount(); unsubscribe = registry.subscribe(update); update(); },
    options: range => queryOptions<ConsumptionReport>({
      queryKey: [queryKey, range],
      initialData: () => { const cached = report(range); return hasConsumptionReading(cached) ? cached : undefined; },
      queryFn: () => start(range),
      staleTime: 1000,
      gcTime: 5 * 60000,
      refetchInterval: query => query.state.data?.scanning ? 1500 : 60000,
      retry: false,
    }),
    async refresh(range) { client.setQueryData([queryKey, range], start(range, true)); },
    dispose() { closed = true; unsubscribe?.(); unsubscribe = undefined; client.unmount(); if (!sharedClient) client.clear(); },
  };
}
