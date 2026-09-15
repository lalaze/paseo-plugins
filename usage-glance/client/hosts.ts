import { isCancelledError } from '@tanstack/react-query';
import type { ConsumptionQuery } from './consumption-query';
import type { ConsumptionRange, ConsumptionReport } from '../shared/consumption';
import type { HostIdentity } from '../shared/hosts';
import { coversConsumptionRange } from '../shared/consumption-cache';

export const rangeKey = (range: ConsumptionRange) => JSON.stringify([range.since, range.until, range.timezone]);
export type HostRuntime = { consumption: ConsumptionQuery };
export type HostEntry = HostIdentity & {
  online: boolean;
  reports: Map<string, ConsumptionReport>;
  errors: Map<string, number>;
  pending: Map<string, Promise<void>>;
  runtime?: HostRuntime;
};

export function cachedHostConsumption(host: HostEntry, range: ConsumptionRange) {
  return [...host.reports.values()].reverse().find(report => coversConsumptionRange(report.range, range));
}

/** Shared by this plugin's independently evaluated bundles in one Paseo client.
 * Only instances loaded by Paseo register their own, already-authorized RPCs.
 * No private app stores, addresses or credentials are discovered here.
 */
// Hermes eval cannot reliably instantiate bundled anonymous classes.
export function createHostRegistry() {
  const entries = new Map<string, HostEntry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly HostEntry[] = [];
  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function emit() {
    snapshot = [...entries.values()].map(entry => ({ ...entry })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    for (const listener of listeners) listener();
  }
  function get(id: string) { return entries.get(id); }
  function register(runtime: HostRuntime) {
    let id: string | undefined, namedByClient = false, closed = false;
    const capture = () => {
      const entry = id && entries.get(id);
      if (!entry || entry.runtime !== runtime || closed) return;
      let changed = false;
      const present = new Set<string>();
      for (const query of runtime.consumption.client.getQueryCache().findAll({ queryKey: ['token-consumption'] })) {
        let report = query.state.data as ConsumptionReport | undefined;
        const range = report?.range ?? query.queryKey[1] as ConsumptionRange | undefined;
        if (!range) continue;
        const key = rangeKey(range), failed = query.state.status === 'error' && !isCancelledError(query.state.error);
        if (failed && entry.errors.get(key) !== query.state.errorUpdatedAt) { entry.errors.set(key, query.state.errorUpdatedAt); changed = true; }
        if (!report && failed) report = entry.reports.get(key) ?? { range, scanning: true, sources: [] };
        if (!report) continue;
        present.add(key);
        if (entry.reports.get(key) !== report) {
          entry.reports.delete(key); entry.reports.set(key, report); if (!failed) entry.errors.delete(key); changed = true;
        }
        // A late/retried response may be structurally identical to the cached data.
        if (entry.errors.has(key) && query.state.status === 'success' && query.state.dataUpdatedAt > entry.errors.get(key)!) {
          entry.errors.delete(key); changed = true;
        }
      }
      for (const key of entry.reports.keys()) if (!present.has(key)) { entry.reports.delete(key); changed = true; }
      // Match the service's bounded range cache; disconnected hosts retain these snapshots.
      while (entry.reports.size > 8) entry.reports.delete(entry.reports.keys().next().value!);
      if (changed) emit();
    };
    const unsubscribe = runtime.consumption.client.getQueryCache().subscribe(capture);
    return {
      identify: (identity: { id: string | null; label: string }, fromClient = false) => {
        if (closed || !identity.id) return;
        if (id && id !== identity.id && entries.get(id)?.runtime === runtime) entries.delete(id);
        id = identity.id;
        let entry = entries.get(id);
        if (!entry || entry.runtime !== runtime) {
          // Reconnection rechecks Providers before counting any old source again.
          entry = { ...identity, id, online: true, reports: new Map(), errors: new Map(), pending: new Map(), runtime };
          entries.set(id, entry); namedByClient = false;
        }
        const label = fromClient || !namedByClient ? identity.label : entry.label;
        const changed = entry.label !== label;
        entry.label = label; namedByClient ||= fromClient;
        capture();
        if (changed || !snapshot.some(host => host.id === id && host.runtime === runtime)) emit();
      },
      dispose: () => {
        closed = true; unsubscribe();
        const entry = id && entries.get(id);
        if (!entry || entry.runtime !== runtime) return;
        entry.online = false; entry.runtime = undefined; entry.pending.clear();
        emit();
      },
    };
  }
  function ensure(id: string, range: ConsumptionRange, force = false): Promise<void> {
    const entry = entries.get(id), runtime = entry?.runtime;
    if (!entry || !runtime || !entry.online) return Promise.resolve();
    const readRange = cachedHostConsumption(entry, range)?.range ?? range;
    const key = rangeKey(readRange), pending = entry.pending.get(key);
    if (pending) return pending;
    const options = runtime.consumption.options(readRange), state = runtime.consumption.client.getQueryState<ConsumptionReport>(options.queryKey);
    if (!force && ((state?.data && !state.isInvalidated && !state.data.scanning && Date.now() - state.dataUpdatedAt < 60000) || Date.now() - (entry.errors.get(key) ?? 0) < 15000)) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('主机响应超时')), 8000); });
    const request = Promise.resolve().then(async () => {
      if (force) await runtime.consumption.refresh(readRange);
      else await runtime.consumption.client.fetchQuery({ ...options, staleTime: state?.data?.scanning ? 0 : 60000 });
    });
    const task = Promise.race([request, timeout]).then(() => {
      if (entries.get(id) === entry && entry.runtime === runtime) entry.errors.delete(key);
    }, error => {
      if (entries.get(id) === entry && entry.runtime === runtime && !isCancelledError(error)) entry.errors.set(key, Date.now());
    }).finally(() => {
      clearTimeout(timer);
      if (entries.get(id) !== entry || entry.runtime !== runtime) return;
      entry.pending.delete(key); emit();
    });
    entry.pending.set(key, task); emit();
    return task;
  }
  return { getSnapshot, subscribe, get, register, ensure };
}
export type HostRegistry = ReturnType<typeof createHostRegistry>;

const registryKey = Symbol.for('lalaze.paseo-usage-glance.host-registry.v3');
export function getHostRegistry(): HostRegistry {
  const shared = globalThis as typeof globalThis & { [registryKey]?: HostRegistry };
  return shared[registryKey] ??= createHostRegistry();
}
export type HostRegistration = ReturnType<HostRegistry['register']>;
