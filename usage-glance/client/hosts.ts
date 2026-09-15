import { isCancelledError } from '@tanstack/react-query';
import type { ConsumptionQuery } from './consumption-query';
import type { HeaderPreference } from './preference';
import type { UsageQuery } from './query';
import type { ConsumptionRange, ConsumptionReport } from '../shared/consumption';
import type { HostIdentity } from '../shared/hosts';
import type { UsageResult } from '../shared/usage';

export const rangeKey = (range: ConsumptionRange) => JSON.stringify([range.since, range.until, range.timezone]);
export type HostRuntime = { consumption: ConsumptionQuery; query: UsageQuery; preference: HeaderPreference };
export type HostEntry = HostIdentity & {
  online: boolean;
  reports: Map<string, ConsumptionReport>;
  errors: Map<string, number>;
  pending: Map<string, Promise<void>>;
  quota?: UsageResult;
  quotaError: boolean;
  quotaLoading: boolean;
  runtime?: HostRuntime;
};

/** Shared by this plugin's independently evaluated bundles in one Paseo client.
 * Only instances loaded by Paseo register their own, already-authorized RPCs.
 * No private app stores, addresses or credentials are discovered here.
 */
export class HostRegistry {
  private entries = new Map<string, HostEntry>();
  private listeners = new Set<() => void>();
  private snapshot: readonly HostEntry[] = [];
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() {
    this.snapshot = [...this.entries.values()].map(entry => ({ ...entry })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    for (const listener of this.listeners) listener();
  }
  get(id: string) { return this.entries.get(id); }
  register(runtime: HostRuntime) {
    let id: string | undefined, namedByClient = false, closed = false;
    const capture = () => {
      const entry = id && this.entries.get(id);
      if (!entry || entry.runtime !== runtime || closed) return;
      let changed = false;
      const present = new Set<string>();
      for (const query of runtime.consumption.client.getQueryCache().findAll({ queryKey: ['token-consumption'] })) {
        const report = query.state.data as ConsumptionReport | undefined;
        if (!report) continue;
        const key = rangeKey(report.range);
        present.add(key);
        if (entry.reports.get(key) !== report) {
          entry.reports.delete(key); entry.reports.set(key, report); entry.errors.delete(key); changed = true;
        }
        // A late/retried response may be structurally identical to the cached data.
        if (entry.errors.has(key) && query.state.status === 'success' && query.state.dataUpdatedAt > entry.errors.get(key)!) {
          entry.errors.delete(key); changed = true;
        }
      }
      for (const key of entry.reports.keys()) if (!present.has(key)) { entry.reports.delete(key); changed = true; }
      // Match the service's bounded range cache; disconnected hosts retain these snapshots.
      while (entry.reports.size > 8) entry.reports.delete(entry.reports.keys().next().value!);
      const quota = runtime.query.client.getQueryState<UsageResult>(runtime.query.options.queryKey);
      if (quota && (entry.quota !== quota.data || entry.quotaError !== (quota.status === 'error') || entry.quotaLoading !== (quota.fetchStatus === 'fetching'))) {
        entry.quota = quota.data; entry.quotaError = quota.status === 'error'; entry.quotaLoading = quota.fetchStatus === 'fetching'; changed = true;
      }
      if (changed) this.emit();
    };
    const unsubscribe = runtime.query.client.getQueryCache().subscribe(capture);
    const unsubscribeConsumption = runtime.consumption.client === runtime.query.client ? () => {} : runtime.consumption.client.getQueryCache().subscribe(capture);
    return {
      identify: (identity: { id: string | null; label: string }, fromClient = false) => {
        if (closed || !identity.id) return;
        if (id && id !== identity.id && this.entries.get(id)?.runtime === runtime) this.entries.delete(id);
        id = identity.id;
        let entry = this.entries.get(id);
        if (!entry || entry.runtime !== runtime) {
          // Reconnection rechecks Providers before counting any old source again.
          entry = { ...identity, id, online: true, reports: new Map(), errors: new Map(), pending: new Map(), quotaError: false, quotaLoading: true, runtime };
          this.entries.set(id, entry); namedByClient = false;
        }
        const label = fromClient || !namedByClient ? identity.label : entry.label;
        const changed = entry.label !== label;
        entry.label = label; namedByClient ||= fromClient;
        capture();
        if (changed || !this.snapshot.some(host => host.id === id && host.runtime === runtime)) this.emit();
      },
      dispose: () => {
        closed = true; unsubscribe(); unsubscribeConsumption();
        const entry = id && this.entries.get(id);
        if (!entry || entry.runtime !== runtime) return;
        entry.online = false; entry.runtime = undefined; entry.pending.clear(); entry.quotaLoading = false;
        this.emit();
      },
    };
  }
  ensure(id: string, range: ConsumptionRange, force = false): Promise<void> {
    const entry = this.entries.get(id), runtime = entry?.runtime;
    if (!entry || !runtime || !entry.online) return Promise.resolve();
    const key = rangeKey(range), pending = entry.pending.get(key);
    if (pending) return pending;
    const options = runtime.consumption.options(range), state = runtime.consumption.client.getQueryState<ConsumptionReport>(options.queryKey);
    if (!force && ((state?.data && !state.isInvalidated && !state.data.scanning && Date.now() - state.dataUpdatedAt < 60000) || Date.now() - (entry.errors.get(key) ?? 0) < 15000)) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('主机响应超时')), 8000); });
    const request = Promise.resolve().then(async () => {
      if (force) await runtime.consumption.refresh(range);
      else await runtime.consumption.client.fetchQuery({ ...options, staleTime: state?.data?.scanning ? 0 : 60000 });
    });
    const task = Promise.race([request, timeout]).then(() => {
      if (this.entries.get(id) === entry && entry.runtime === runtime) entry.errors.delete(key);
    }, error => {
      if (this.entries.get(id) === entry && entry.runtime === runtime && !isCancelledError(error)) entry.errors.set(key, Date.now());
    }).finally(() => {
      clearTimeout(timer);
      if (this.entries.get(id) !== entry || entry.runtime !== runtime) return;
      entry.pending.delete(key); this.emit();
    });
    entry.pending.set(key, task); this.emit();
    return task;
  }
  async refreshQuota(id: string) {
    const runtime = this.entries.get(id)?.runtime;
    if (!runtime) return;
    await runtime.query.client.fetchQuery({ ...runtime.query.options, staleTime: 0 }).catch(() => {});
  }
}

const registryKey = Symbol.for('lalaze.paseo-usage-glance.host-registry.v1');
export function getHostRegistry(): HostRegistry {
  const shared = globalThis as typeof globalThis & { [registryKey]?: HostRegistry };
  return shared[registryKey] ??= new HostRegistry();
}
export type HostRegistration = ReturnType<HostRegistry['register']>;
