import { promises as fs } from 'node:fs';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const readAuth = async path => JSON.parse(await fs.readFile(path, 'utf8'));

function selectedCredential(auth, extract) {
  const token = extract(auth);
  if (!token || auth?.access_token === token) return null; // Keep legacy/static keys unchanged.
  return Object.values(auth ?? {}).find(value => value && typeof value === 'object' && value.key === token) ?? null;
}

export function needsGrokRefresh(auth, extract, now = Date.now()) {
  const credential = selectedCredential(auth, extract);
  return credential?.auth_mode === 'oidc'
    && typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
    && typeof credential.expires_at === 'string'
    && Number.isFinite(Date.parse(credential.expires_at))
    && Date.parse(credential.expires_at) <= now + 300000;
}

/** Each request rereads disk, including after another CLI process rotates the token. */
export function createGrokRefresher({ run = renewWithGrok, read = readAuth, now = Date.now } = {}) {
  const inFlight = new Map(), retryAfter = new Map();
  return async (path, extract) => {
    const initial = await read(path);
    if (needsGrokRefresh(initial, extract, now())) {
      if (!inFlight.has(path) && (retryAfter.get(path) ?? 0) <= now()) {
        const task = Promise.resolve().then(() => run(path, extract)).then(() => {
          retryAfter.delete(path);
        }).catch(() => {
          // Never put CLI output, OAuth responses or credentials in logs/client errors.
          retryAfter.set(path, now() + 60000);
        }).finally(() => inFlight.delete(path));
        inFlight.set(path, task);
      }
      await inFlight.get(path);
    }
    return extract(await read(path));
  };
}
export const readFreshGrokToken = createGrokRefresher();

async function binaryPath() {
  const explicit = process.env.PASEO_GROK_BIN;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('PASEO_GROK_BIN must be absolute');
    await fs.access(explicit, 1);
    return explicit;
  }
  let configured;
  try {
    const config = JSON.parse(await fs.readFile(join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'config.json'), 'utf8'));
    configured = config.agents?.providers?.grok?.command?.[0];
  } catch { /* Standard CLI fallback. */ }
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const candidates = [
    ...(typeof configured === 'string' ? (isAbsolute(configured) ? [configured] : paths.map(dir => join(dir, configured))) : []),
    ...paths.map(dir => join(dir, 'grok')),
    join(homedir(), '.grok/bin/grok'),
  ];
  for (const bin of candidates) {
    if (!isAbsolute(bin)) continue;
    try { await fs.access(bin, 1); return bin; } catch { /* Try the next install. */ }
  }
  throw new Error('Grok binary not found');
}

/** Grok owns the OAuth lock, rotation and atomic credential write. No session/prompt. */
export async function renewWithGrok(path, extract, dependencies = {}) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Linux or macOS required');
  const bin = dependencies.bin ?? await binaryPath();
  const start = dependencies.spawn ?? spawn, read = dependencies.read ?? readAuth;
  const sleep = dependencies.sleep ?? delay, now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 15000;
  const env = { ...process.env, GROK_HOME: dirname(path), GROK_AUTH_PATH: path, GROK_AUTH_EARLY_INVALIDATION_SECS: '300' };
  // An inherited inline credential must not shadow the file we are renewing.
  delete env.GROK_AUTH;
  const child = start(bin, ['agent', '--no-leader', 'stdio'], {
    cwd: dirname(path), detached: true, stdio: ['pipe', 'ignore', 'ignore'], env,
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  child.stdin?.on('error', () => {});
  const kill = signal => {
    if (child.pid) {
      try { (dependencies.killGroup ?? process.kill)(-child.pid, signal); } catch { /* Already gone. */ }
    }
  };
  const cleanup = () => kill('SIGTERM');
  process.once('exit', cleanup);
  try {
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'paseo-quota-refresh', version: '1.0' },
    } }) + '\n');
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      try {
        const credential = selectedCredential(await read(path), extract);
        if (credential?.key && Date.parse(credential.expires_at) > now() + 300000) return;
      } catch { /* Wait for atomic write. */ }
      if (exited) break;
      await sleep(100);
    }
    throw new Error('Grok credential renewal unavailable');
  } finally {
    cleanup();
    await sleep(300);
    // Also remove descendants if the direct child exited before them.
    kill('SIGKILL');
    child.stdin?.destroy();
    process.removeListener('exit', cleanup);
  }
}
