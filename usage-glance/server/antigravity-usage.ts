import type { PluginServerContext } from '@getpaseo/plugin/server';
import { readAntigravityQuota, type AntigravityQuotaSnapshot } from '../shared/antigravity-quota';
import { readOfficialQuota, type OfficialQuotaReader } from './antigravity-quota';

/** Plugin RPC avoids colliding with Paseo's built-in Antigravity usage source. */
export function registerAntigravityQuota(server: PluginServerContext, reader: OfficialQuotaReader = {}, now = Date.now): void {
  let cached: AntigravityQuotaSnapshot | null = null;
  let expiresAt = 0;
  let stale = false;
  let pending: Promise<void> | null = null;
  server.handle(readAntigravityQuota, async () => {
    if (!pending && now() >= expiresAt) {
      stale = true;
      // Return immediately: CLI startup must not hold a 30s plugin RPC open.
      pending = (async () => {
        try {
          const windows = await readOfficialQuota(reader);
          if (windows?.length) {
            cached = { fetchedAt: new Date(now()).toISOString(), windows };
            stale = false;
          }
        } catch { /* Keep the last successful quota; never expose CLI output. */ }
        expiresAt = now() + (stale ? 60000 : 300000);
      })().finally(() => { pending = null; });
    }
    return { ...(cached ?? { fetchedAt: new Date(now()).toISOString(), windows: [] }), stale, refreshing: pending !== null };
  });
}
