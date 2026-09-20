import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CLAUDE_QUOTA_INTERVAL_MS = 15 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function claudeQuotaStatePath() {
  return join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'cache', 'claude-quota-throttle.json');
}

export function retryAfterDeadline(value, now) {
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const deadline = now + Number(value) * 1000;
    if (Number.isFinite(deadline)) return Math.max(now + CLAUDE_QUOTA_INTERVAL_MS, deadline);
  }
  const date = value && /^[A-Za-z]{3},?\s/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date)
    ? Math.max(now + CLAUDE_QUOTA_INTERVAL_MS, date)
    : now + RATE_LIMIT_FALLBACK_MS;
}

function readDeadline(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.version !== 1 || !Number.isFinite(state.nextAllowedAt)) throw new Error('Invalid Claude quota cooldown state');
    return state.nextAllowedAt;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error; // A broken cooldown must not silently enable repeated requests.
  }
}

export function saveClaudeQuotaDeadline(path, nextAllowedAt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, nextAllowedAt }) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

/** One Claude quota reader per daemon; UI polls and forced refreshes share this gate. */
export function createClaudeQuotaFetch(fetchApi, { now = Date.now, stateFile = claudeQuotaStatePath() } = {}) {
  let cached = null;
  let cachedAuthorization = null;
  let inFlight = null;

  async function throttledFetch(input, init) {
    if (String(input) !== USAGE_URL) return fetchApi(input, init);
    if (inFlight) {
      await inFlight.catch(() => {});
      return throttledFetch(input, init);
    }
    const authorization = new Headers(init?.headers).get('authorization');
    const nextAllowedAt = readDeadline(stateFile);
    if (now() < nextAllowedAt) {
      if (cached && authorization === cachedAuthorization) return cached.clone();
      // Do not show another account's cached quota after credentials change. Only the
      // deadline survives a restart; credentials and quota responses stay in memory.
      throw new Error(`Claude quota query paused until ${new Date(nextAllowedAt).toISOString()}`);
    }
    saveClaudeQuotaDeadline(stateFile, now() + CLAUDE_QUOTA_INTERVAL_MS);
    cached = null;
    cachedAuthorization = null;
    inFlight = (async () => {
      const response = await fetchApi(input, init);
      if (response.status === 429) {
        saveClaudeQuotaDeadline(stateFile, retryAfterDeadline(response.headers.get('retry-after'), now()));
      }
      cached = response.clone();
      cachedAuthorization = authorization;
      return response;
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  }
  return throttledFetch;
}
