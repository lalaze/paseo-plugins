import type { PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import { officialAgyReady, readOfficialQuota, type AntigravityQuotaWindow, type OfficialQuotaReader } from './antigravity-quota';

const input = z.object({}).strict();

const unavailable = {
  status: 'unavailable' as const,
  problem: { kind: 'no_quota' as const, detail: 'Sign in with agy, then refresh Antigravity quota.' },
};

type UsageReport = typeof unavailable | { status: 'available'; windows: AntigravityQuotaWindow[] };

export interface AntigravityUsageHost {
  registerUsageSource?(source: {
    id: string;
    label: string;
    input: { parseAsync(value: unknown): Promise<unknown> };
    discover(scope: { kind: string }): Promise<Array<{ key: string; input: Record<string, never> }>>;
    fetch(value: unknown): Promise<UsageReport>;
  }): void;
}

/** Publish official provider id `antigravity` so listUsage can show its remaining quota. */
export function registerAntigravityUsage(server: PluginServerContext, reader: OfficialQuotaReader = {}): void {
  const host = server as PluginServerContext & AntigravityUsageHost;
  host.registerUsageSource?.({
    id: 'antigravity',
    label: 'Antigravity',
    input,
    discover: async scope => scope.kind === 'global' && await officialAgyReady(reader) ? [{ key: 'default', input: {} }] : [],
    fetch: async () => {
      const windows = await readOfficialQuota(reader);
      return windows?.length ? { status: 'available', windows } : unavailable;
    },
  });
}
