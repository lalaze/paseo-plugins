import type { PluginServerContext } from '@getpaseo/plugin/server';
import { readAntigravityQuota, type AntigravityQuotaSnapshot } from '../shared/antigravity-quota';
import { readOfficialQuota, type OfficialQuotaReader } from './antigravity-quota';

/** Plugin RPC avoids colliding with Paseo's built-in Antigravity usage source. */
export function registerAntigravityQuota(server: PluginServerContext, reader: OfficialQuotaReader = {}, now = Date.now): void {
  let cached: AntigravityQuotaSnapshot | null = null;
  let expiresAt = 0;
  let pending: Promise<AntigravityQuotaSnapshot> | null = null;
  server.handle(readAntigravityQuota, async () => {
    if (cached && now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      const windows = await readOfficialQuota(reader);
      cached = { fetchedAt: new Date(now()).toISOString(), windows: windows ?? [] };
      expiresAt = now() + (cached.windows.length ? 300000 : 60000);
      return cached;
    })();
    try { return await pending; }
    finally { pending = null; }
  });
}
