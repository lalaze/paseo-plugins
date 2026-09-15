import type { PaseoApi } from '@getpaseo/client';
import { enabledConsumptionSources } from '../shared/consumption';
import { backgroundConsumptionRange } from '../shared/consumption-cache';
import type { ConsumptionService } from './consumption';

/** The daemon keeps warming recent usage after the client/page disconnects. */
export function startConsumptionSync(service: ConsumptionService, now = () => new Date()) {
  let paseo: PaseoApi | undefined, closed = false, running = false;
  const timezones = new Set<string>();
  const tick = async () => {
    if (closed || running || !paseo) return;
    running = true;
    try {
      const snapshot = await paseo.providers.snapshot();
      if (closed) return;
      const sources = enabledConsumptionSources(snapshot.entries);
      for (const timezone of timezones) service.get(backgroundConsumptionRange(timezone, now()), sources, true);
    } catch {
      // Preserve the last reading. Foreground RPCs still report connection/Provider errors.
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60000);
  timer.unref?.();
  return {
    watch(api: PaseoApi, timezone: string) {
      if (closed) return;
      paseo = api;
      timezones.delete(timezone); timezones.add(timezone);
      // Keep work bounded when multiple clients use different timezones.
      while (timezones.size > 2) timezones.delete(timezones.values().next().value!);
    },
    dispose() { closed = true; clearInterval(timer); timezones.clear(); paseo = undefined; },
  };
}
