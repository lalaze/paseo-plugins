import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const METHODS = ['RetrieveUserQuotaSummary', 'GetUserStatus', 'GetCommandModelConfigs'];
const supported = () => process.platform === 'linux' || process.platform === 'darwin';

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Parse `lsof -Fn` NAME lines; only used for a single process's TCP LISTEN sockets. */
export function parseLsofListenPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout).split('\n')) {
    if (!line.startsWith('n')) continue;
    const match = line.slice(1).replace(/\s+\(.*\)$/, '').match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

/** Parse `lsof -Fpf` and keep PIDs that have the file mapped as the executable. */
export function parseLsofTxtPids(stdout) {
  const pids = new Set();
  let pid;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line === 'ftxt' && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function csrfFromCommand(text) {
  const args = Array.isArray(text) ? text : String(text).trim().split(/\s+/);
  const assigned = args.find(x => x.startsWith('--csrf_token='))?.slice(13);
  if (assigned) return assigned;
  const i = args.indexOf('--csrf_token');
  return i >= 0 ? args[i + 1] : undefined;
}

/** `/proc/pid/exe` keeps the original path after the file is replaced. */
export function exeLinkPath(link) {
  return String(link).replace(/ \(deleted\)$/, '');
}

export function parseAppConfigCsrf(html) {
  const match = String(html).match(/window\.__APP_CONFIG__ = (.*?);/);
  if (!match) return;
  try {
    const token = JSON.parse(match[1]).csrfToken;
    return typeof token === 'string' && token.length ? token : undefined;
  } catch { /* Ignore malformed app config. */ }
}

function fetchHtml(port, timeoutMs, protocol) {
  const lib = protocol === 'https' ? https : http;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = lib.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', family: 4, rejectUnauthorized: false, agent: false }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 256 * 1024) { req.destroy(); done(''); } else chunks.push(chunk);
      });
      res.on('error', () => done(''));
      res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => done(''));
    timer = setTimeout(() => { req.destroy(); done(''); }, Math.max(1, timeoutMs));
    req.end();
  });
}

/** Hub CSRF lives in the process-owned loopback page, not `--csrf_token`. */
export async function csrfFromOwnedPorts(ports, timeoutMs = 800) {
  for (const port of ports) {
    for (const protocol of ['http', 'https']) {
      if (timeoutMs <= 0) return;
      const start = Date.now();
      const token = parseAppConfigCsrf(await fetchHtml(port, timeoutMs, protocol));
      if (token) return token;
      timeoutMs -= Date.now() - start;
    }
  }
}

export async function resolveBinaries() {
  const home = homedir();
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(join(process.env.PASEO_HOME || join(home, '.paseo'), 'config.json'), 'utf8'));
  } catch { /* Use standard installation below. */ }
  const acp = config.agents?.providers?.['antigravity-acp']?.env?.AGY_BIN;
  const hub = process.env.AGY_HUB_BIN || config.agents?.providers?.['antigravity-hub']?.env?.AGY_HUB_BIN;
  const explicit = process.env.PASEO_ANTIGRAVITY_BIN || process.env.ANTIGRAVITY_CLI_PATH || acp;
  const fromPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'agy'));
  const candidates = [explicit, hub, ...fromPath, join(home, '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy', join(home, '.gemini/bin/agy')];
  const seen = new Set();
  const bins = [];
  let last;
  for (const bin of candidates) {
    if (!bin) continue;
    if (!isAbsolute(bin)) throw new Error('Antigravity binary must be absolute');
    try {
      await fs.access(bin, 1);
      const real = await fs.realpath(bin);
      if (seen.has(real)) continue;
      seen.add(real);
      bins.push(real);
    } catch (error) { last = error; }
  }
  if (bins.length) return bins;
  throw last ?? new Error('Antigravity binary not found; set PASEO_ANTIGRAVITY_BIN or AGY_HUB_BIN');
}

export async function resolveBinary() {
  return (await resolveBinaries())[0];
}

async function descendantPids(pid) {
  const kids = (await run('/usr/bin/pgrep', ['-P', String(pid)])).trim().split(/\s+/).map(Number).filter(n => n > 0);
  const all = [];
  for (const kid of kids) all.push(kid, ...(await descendantPids(kid)));
  return all;
}

/** Match sockets owned by this process, never scan unrelated localhost services. */
export async function listeningPorts(pid) {
  if (process.platform === 'darwin') {
    const ports = new Set();
    for (const p of [pid, ...await descendantPids(pid)]) {
      for (const port of parseLsofListenPorts(await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(p), '-iTCP', '-sTCP:LISTEN', '-Fn']))) ports.add(port);
    }
    return [...ports];
  }
  const base = `/proc/${pid}`;
  const sockets = new Set();
  for (const fd of await fs.readdir(`${base}/fd`)) {
    try {
      const match = (await fs.readlink(`${base}/fd/${fd}`)).match(/^socket:\[(\d+)\]$/);
      if (match) sockets.add(match[1]);
    } catch { /* File descriptor closed. */ }
  }
  const ports = new Set();
  for (const table of ['tcp', 'tcp6']) {
    let data;
    try { data = await fs.readFile(`${base}/net/${table}`, 'utf8'); } catch { continue; }
    for (const row of data.trim().split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] === '0A' && sockets.has(fields[9])) ports.add(parseInt(fields[1].split(':')[1], 16));
    }
  }
  return [...ports];
}

export function requestQuota(port, method, csrf, timeoutMs, hostname = '127.0.0.1') {
  return new Promise(resolve => {
    // Self-signed TLS is accepted ONLY for a process-owned loopback endpoint.
    const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
    if (csrf) headers['x-codeium-csrf-token'] = csrf;
    let settled = false;
    let timer;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = https.request({ hostname, port, family: hostname.includes(':') ? 6 : 4, path: `/exa.language_server_pb.LanguageServerService/${method}`, method: 'POST', rejectUnauthorized: false, agent: false, headers }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(); done(null); } else chunks.push(chunk);
      });
      res.on('error', () => done(null));
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); }
      });
    });
    req.on('error', () => done(null));
    timer = setTimeout(() => { req.destroy(); done(null); }, Math.max(1, timeoutMs));
    req.end(JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } }));
  });
}

async function probe(pid, csrf, parse, deadline, methods = METHODS) {
  let ports;
  try { ports = await listeningPorts(pid); } catch { return null; }
  if (!csrf) csrf = await csrfFromOwnedPorts(ports, Math.min(800, Math.max(1, deadline - Date.now())));
  const tokens = csrf ? [csrf, undefined] : [undefined];
  for (const method of methods) {
    for (const port of ports) {
      for (const host of ['127.0.0.1', '::1']) {
        for (const token of tokens) {
          if (Date.now() >= deadline) return null;
          const payload = await requestQuota(port, method, token, Math.min(1500, deadline - Date.now()), host);
          const windows = parse(payload);
          if (windows.length) return windows;
        }
      }
    }
  }
  return null;
}

async function processExeMatches(pid, bin) {
  const base = `/proc/${pid}`;
  try {
    const expected = await fs.stat(bin);
    const actual = await fs.stat(`${base}/exe`);
    if (actual.dev === expected.dev && actual.ino === expected.ino) return true;
  } catch { /* Missing or unreadable. */ }
  try {
    const link = exeLinkPath(await fs.readlink(`${base}/exe`));
    if (link === bin) return true;
    try { if (await fs.realpath(link) === bin) return true; } catch { /* Replaced or deleted. */ }
  } catch { /* Not a linux proc exe link. */ }
  return false;
}

async function reuseBinary(bin, parse, deadline) {
  if (process.platform === 'darwin') {
    const pids = parseLsofTxtPids(await run('/usr/sbin/lsof', ['-nP', '-u', String(process.getuid()), '-Fpf', bin]));
    for (const pid of pids) {
      if (Date.now() >= deadline) break;
      const csrf = csrfFromCommand(await run('/bin/ps', ['-p', String(pid), '-www', '-o', 'args=']));
      const result = await probe(pid, csrf, parse, deadline);
      if (result) return result;
    }
    return null;
  }
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Date.now() >= deadline) continue;
    try {
      const base = `/proc/${entry}`;
      const owner = await fs.stat(base);
      if (owner.uid !== process.getuid()) continue;
      if (!await processExeMatches(Number(entry), bin)) continue;
      const args = (await fs.readFile(`${base}/cmdline`, 'utf8')).split('\0');
      const csrf = csrfFromCommand(args);
      const result = await probe(Number(entry), csrf, parse, deadline);
      if (result) return result;
    } catch { /* Process exited or is not readable. */ }
  }
  return null;
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Reuse signed-in agy/hub or own one short-lived Hub. Never send a prompt. */
export async function readLocalQuota(parse, { trace = () => {} } = {}) {
  if (!supported()) return null;
  const bins = await resolveBinaries();
  trace(`binary ${bins.join(' ')}`);
  for (const bin of bins) {
    const reused = await reuseBinary(bin, parse, Date.now() + 4000);
    if (reused) {
      trace(`reused existing agy ${bin}`);
      return reused;
    }
  }
  const bin = bins[0];
  const pty = require('node-pty');
  // agy 1.2 CLI no longer serves LanguageServerService without --hub; --csrf_token can still exit immediately.
  const hubPort = await freeLoopbackPort();
  const proc = pty.spawn(bin, ['--hub', `--hub-port=${hubPort}`, '--app_data_dir=antigravity'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', AGY_ENABLE_HUB: '1', ANTIGRAVITY_VSCODE_HOST: '1' },
  });
  let exited = false;
  const exitEvent = proc.onExit(event => { exited = true; trace(`spawn exited code=${event?.exitCode ?? 'unknown'}`); });
  const dataEvent = proc.onData(() => {});
  const cleanup = () => { if (!exited) { try { proc.kill('SIGTERM'); } catch { /* Exited. */ } } };
  process.once('exit', cleanup);
  trace(`spawned pid=${proc.pid} hub-port=${hubPort}`);
  try {
    const deadline = Date.now() + 15000;
    while (!exited && Date.now() < deadline) {
      const owned = await probe(proc.pid, undefined, parse, deadline, ['RetrieveUserQuotaSummary']);
      if (owned) return owned;
      // Children may be a different pid of the same binary (macOS language_server).
      const child = await reuseBinary(bin, parse, Date.now() + 400);
      if (child) return child;
      if (Date.now() < deadline) await delay(350);
    }
    if (!exited) {
      const late = await probe(proc.pid, undefined, parse, Date.now() + 3000, METHODS.slice(1));
      if (late) return late;
    }
    trace(exited ? 'agy exited before quota API was ready' : 'no quota windows from process-owned ports');
    return null;
  } finally {
    cleanup();
    for (let i = 0; i < 10 && !exited; i++) await delay(50);
    if (!exited) { try { proc.kill('SIGKILL'); } catch { /* Exited. */ } }
    dataEvent.dispose();
    exitEvent.dispose();
    process.removeListener('exit', cleanup);
  }
}
