import { unavailableUsage, windowFromUsedPct, toneFromUsedPct } from '../usage.js';
import { readLocalQuota } from './antigravity-local.js';

const array = value => Array.isArray(value) ? value : [];
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const reset = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Convert real quota fields only; absent protobuf scalars are not assumed to be zero. */
export function quotaWindows(payload) {
  const windows = [];
  const seen = new Set();
  function add(id, label, remaining, resetsAt) {
    const f = fraction(remaining);
    if (f === null || seen.has(id)) return;
    seen.add(id);
    const usedPct = Math.round((1 - f) * 10000) / 100;
    windows.push(windowFromUsedPct({ id, label, utilizationPct: usedPct, resetsAt: reset(resetsAt), tone: toneFromUsedPct(usedPct) }));
  }
  for (const [gi, group] of array(payload?.response?.groups ?? payload?.groups).entries()) {
    if (!group || typeof group !== 'object') continue;
    const name = typeof group.displayName === 'string' ? group.displayName : `Group ${gi + 1}`;
    for (const [bi, bucket] of array(group.buckets).entries()) {
      if (!bucket || typeof bucket !== 'object') continue;
      const period = bucket.window === 'weekly' ? 'Weekly limit' : bucket.window === '5h' ? '5-hour limit' : 'Quota';
      add(`agy_${gi}_${bucket.bucketId ?? bi}`, `${name} · ${period}`, bucket.remainingFraction ?? bucket.remaining?.remainingFraction, bucket.resetTime ?? bucket.remaining?.resetTime);
    }
  }
  if (windows.length) return windows;
  const data = payload?.userStatus?.cascadeModelConfigData ?? payload?.cascadeModelConfigData ?? payload;
  for (const [i, model] of array(data?.clientModelConfigs).entries()) {
    if (!model?.quotaInfo) continue;
    add(`agy_model_${model.modelOrAlias?.model ?? i}`, `${model.label ?? `Model ${i + 1}`} · Quota`, model.quotaInfo.remainingFraction, model.quotaInfo.resetTime);
  }
  return windows;
}

export class AntigravityQuotaProvider {
  providerId = 'antigravity-acp';
  displayName = 'Google Antigravity 2.0';
  constructor(options) {
    this.logger = options.logger.child({ module: 'antigravity-quota-provider' });
    this.readQuota = options.readQuota ?? readLocalQuota;
    this.inFlight = null;
  }
  fetchUsage() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchFresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async fetchFresh() {
    try {
      const windows = await this.readQuota(quotaWindows);
      if (!windows?.length) return unavailableUsage(this);
      return { providerId: this.providerId, displayName: this.displayName, status: 'available', planLabel: null, windows, balances: [], details: [], error: null };
    } catch {
      // Never forward CLI output, credential contents, or response bodies to logs/client.
      this.logger.debug('Antigravity local quota unavailable; check agy login and local API readiness');
      return unavailableUsage(this);
    }
  }
}
