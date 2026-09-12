import { promises as fs } from 'node:fs';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export function needsKimiRefresh(credentials, nowMs = Date.now()) {
  return typeof credentials?.expires_at === 'number' && Number.isFinite(credentials.expires_at)
    && credentials.expires_at * 1000 <= nowMs + 300000
    && typeof credentials.refresh_token === 'string' && credentials.refresh_token.length > 0;
}

/** Coalesce per credential file and suppress repeated failures for one minute. */
export function createCredentialRefresher({ run = renewWithKimi, now = Date.now } = {}) {
  const inFlight = new Map();
  const retryAfter = new Map();
  return async (path, credentials) => {
    if (!needsKimiRefresh(credentials, now())) return;
    if (inFlight.has(path)) return inFlight.get(path);
    if ((retryAfter.get(path) ?? 0) > now()) return;
    const task = Promise.resolve().then(() => run(path)).then(() => {
      retryAfter.delete(path);
    }).catch(() => {
      // CLI output, server token and OAuth errors must not reach Paseo logs/client.
      retryAfter.set(path, now() + 60000);
    }).finally(() => inFlight.delete(path));
    inFlight.set(path, task);
    return task;
  };
}
export const ensureKimiCredentialsFresh = createCredentialRefresher();

async function binaryPath() {
  let configured;
  try {
    const c = JSON.parse(await fs.readFile(join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'config.json'), 'utf8'));
    configured = c.agents?.providers?.kimi?.command?.[0];
  } catch { /* Standard install fallback. */ }
  const explicit = process.env.PASEO_KIMI_BIN;
  const fromPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'kimi'));
  const candidates = [
    explicit,
    typeof configured === 'string' ? configured : '',
    ...fromPath,
    join(homedir(), '.kimi-code/bin/kimi'),
    '/opt/homebrew/bin/kimi',
    '/usr/local/bin/kimi',
  ].filter(value => typeof value === 'string' && value.length > 0);
  let last;
  for (const bin of candidates) {
    if (!isAbsolute(bin)) {
      last = new Error('Kimi binary must be absolute');
      continue;
    }
    try {
      await fs.access(bin, 1);
      return bin;
    } catch (error) { last = error; }
  }
  throw last ?? new Error('Kimi binary not found; set PASEO_KIMI_BIN');
}

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

async function descendantPids(pid) {
  const kids = (await run('/usr/bin/pgrep', ['-P', String(pid)])).trim().split(/\s+/).map(Number).filter(n => n > 0);
  const all = [];
  for (const kid of kids) all.push(kid, ...(await descendantPids(kid)));
  return all;
}

function portsFromLsof(stdout) {
  const ports = new Set();
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('n')) continue;
    const match = line.slice(1).replace(/\s+\(.*\)$/, '').match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

/** Enumerate only sockets owned by the child, not arbitrary localhost services. */
async function childPorts(pid) {
  if (process.platform === 'darwin') {
    const ports = new Set();
    for (const p of [pid, ...await descendantPids(pid)]) {
      for (const port of portsFromLsof(await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(p), '-iTCP', '-sTCP:LISTEN', '-Fn']))) ports.add(port);
    }
    return [...ports];
  }
  const base = `/proc/${pid}`;
  const inodes = new Set();
  for (const fd of await fs.readdir(`${base}/fd`)) {
    try {
      const match = (await fs.readlink(`${base}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/);
      if (match) inodes.add(match[1]);
    } catch { /* Closed fd. */ }
  }
  const ports = new Set();
  for (const table of ['tcp', 'tcp6']) {
    let rows;
    try { rows = await fs.readFile(`${base}/net/${table}`, 'utf8'); } catch { continue; }
    for (const row of rows.trim().split('\n').slice(1)) {
      const parts = row.trim().split(/\s+/);
      if (parts[3] === '0A' && inodes.has(parts[9])) ports.add(parseInt(parts[1].split(':')[1], 16));
    }
  }
  return [...ports];
}

export function portsFromBanner(text) {
  const ports = new Set();
  for (const match of String(text).matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/gi)) ports.add(Number(match[1]));
  return [...ports];
}

export function queryLocalUsage(port, token, timeoutMs, hostname = '127.0.0.1', path = '/api/v1/oauth/usage') {
  return new Promise(resolve => {
    let timer;
    let settled = false;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.get({ hostname, family: hostname.includes(':') ? 6 : 4, port, path, agent: false, headers }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { req.destroy(); done(false); } else chunks.push(chunk);
      });
      res.on('error', () => done(false));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const kind = body?.data?.kind;
          done(res.statusCode === 200 && (kind === 'ok' || kind === 'error' || kind === undefined));
        } catch { done(res.statusCode === 200); }
      });
    });
    req.on('error', () => done(false));
    timer = setTimeout(() => { req.destroy(); done(false); }, Math.max(1, timeoutMs));
  });
}

function redact(text) {
  return String(text)
    .replace(/#token=[^\s]+/gi, '#token=redacted')
    .replace(/Bearer\s+\S+/gi, 'Bearer redacted')
    .replace(/\bToken:\s+\S+/gi, 'Token: redacted')
    .slice(-500);
}

function credentialsAreFresh(raw, nowMs) {
  try { return !needsKimiRefresh(JSON.parse(raw), nowMs); }
  catch { return false; }
}

/** Official Kimi OAuth code owns locks, refresh-token rotation and credential writes. */
export async function renewWithKimi(credentialsPath, dependencies = {}) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Linux or macOS required');
  const kimiHome = dirname(dirname(credentialsPath));
  const bin = dependencies.bin ?? await binaryPath();
  const start = dependencies.spawn ?? spawn;
  const portsFor = dependencies.ports ?? childPorts;
  const query = dependencies.query ?? queryLocalUsage;
  const readToken = dependencies.readToken ?? (() => fs.readFile(join(kimiHome, 'server.token'), 'utf8'));
  const readCredentials = dependencies.readCredentials ?? (() => fs.readFile(credentialsPath, 'utf8'));
  const sleep = dependencies.sleep ?? delay;
  const timeoutMs = dependencies.timeoutMs ?? (process.platform === 'darwin' ? 20000 : 12000);
  const now = dependencies.now ?? Date.now;
  const trace = dependencies.trace ?? (() => {});
  // Current kimi web rejects --port 0; default 58627 and busy-port +1 instead.
  const child = start(bin, ['web', '--no-open', '--host', '127.0.0.1'], {
    cwd: kimiHome, stdio: dependencies.stdio ?? 'ignore', detached: true,
    env: { ...process.env, KIMI_CODE_HOME: kimiHome, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0' },
  });
  let exited = false;
  let output = '';
  const onExit = (code, signal) => { exited = true; trace(`kimi web exited code=${code ?? 'null'} signal=${signal ?? 'null'}`); };
  child.once('exit', onExit);
  child.once('error', error => { exited = true; trace(`kimi web spawn error ${error.message}`); });
  if (child.stdout) child.stdout.on('data', chunk => { output += chunk; });
  if (child.stderr) child.stderr.on('data', chunk => { output += chunk; });
  trace(`spawn ${bin} web home=${kimiHome} pid=${child.pid ?? 'none'}`);
  const kill = signal => {
    if (!exited && child.pid) {
      // Private process group created above; never signal an existing user Kimi process.
      try { (dependencies.killGroup ?? process.kill)(-child.pid, signal); } catch { /* Already gone. */ }
      try { process.kill(child.pid, signal); } catch { /* Already gone. */ }
    }
  };
  const cleanup = () => kill('SIGTERM');
  process.once('exit', cleanup);
  try {
    const deadline = now() + timeoutMs;
    let lastPorts = [];
    while (!exited && now() < deadline) {
      let ports = portsFromBanner(output);
      let token = '';
      try { ports = [...new Set([...ports, ...await portsFor(child.pid)])]; } catch { /* Starting up. */ }
      try { token = (await readToken()).trim(); } catch { /* Token file appears after listen. */ }
      if (ports.join() !== lastPorts.join()) {
        lastPorts = ports;
        trace(`ports=${ports.join(',') || 'none'} server.token=${token ? 'yes' : 'no'}`);
      }
      try {
        if (credentialsAreFresh(await readCredentials(), now())) {
          trace('credentials file refreshed');
          return;
        }
      } catch { /* Still stale. */ }
      const auths = token ? [token, ''] : [''];
      for (const port of ports) {
        if (now() >= deadline) break;
        for (const auth of auths) {
          for (const path of ['/api/v1/oauth/usage', '/api/v1/auth']) {
            if (await query(port, auth, Math.min(3000, deadline - now()), '127.0.0.1', path)) {
              trace(`local API ok port=${port} path=${path} auth=${auth ? 'yes' : 'no'}`);
              return;
            }
          }
        }
      }
      if (!exited && now() < deadline) await sleep(150);
    }
    if (output) trace(`kimi web output ${redact(output)}`);
    throw new Error(exited ? 'Kimi credential renewal unavailable; kimi web exited' : 'Kimi credential renewal unavailable');
  } finally {
    cleanup();
    for (let i = 0; i < 10 && !exited; i++) await sleep(50);
    kill('SIGKILL');
    child.removeListener('exit', onExit);
    // Keep the error listener to avoid an unhandled late spawn error.
    process.removeListener('exit', cleanup);
  }
}
