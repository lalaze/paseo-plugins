import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
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

export async function resolveBinary() {
  const home = homedir();
  let configured;
  try {
    const config = JSON.parse(await fs.readFile(join(process.env.PASEO_HOME || join(home, '.paseo'), 'config.json'), 'utf8'));
    configured = config.agents?.providers?.['antigravity-acp']?.env?.AGY_BIN;
  } catch { /* Use standard installation below. */ }
  const explicit = process.env.PASEO_ANTIGRAVITY_BIN || process.env.ANTIGRAVITY_CLI_PATH || configured;
  const fromPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'agy'));
  const candidates = explicit ? [explicit] : [...fromPath, join(home, '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy', join(home, '.gemini/bin/agy')];
  let last;
  for (const bin of candidates) {
    if (!isAbsolute(bin)) throw new Error('Antigravity binary must be absolute');
    try {
      await fs.access(bin, 1);
      return fs.realpath(bin);
    } catch (error) { last = error; }
  }
  throw last ?? new Error('Antigravity binary not found; set PASEO_ANTIGRAVITY_BIN');
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
  const expected = await fs.stat(bin);
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Date.now() >= deadline) continue;
    try {
      const base = `/proc/${entry}`;
      const owner = await fs.stat(base);
      if (owner.uid !== process.getuid()) continue;
      const actual = await fs.stat(`${base}/exe`);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) continue;
      const args = (await fs.readFile(`${base}/cmdline`, 'utf8')).split('\0');
      const csrf = csrfFromCommand(args);
      const result = await probe(Number(entry), csrf, parse, deadline);
      if (result) return result;
    } catch { /* Process exited or is not readable. */ }
  }
  return null;
}

/** Reuse signed-in agy or own one short-lived PTY. Never send a prompt. */
export async function readLocalQuota(parse, { trace = () => {} } = {}) {
  if (!supported()) return null;
  const bin = await resolveBinary();
  trace(`binary ${bin}`);
  const reused = await reuseBinary(bin, parse, Date.now() + 2000);
  if (reused) {
    trace('reused existing agy');
    return reused;
  }
  const pty = require('node-pty');
  // CLI quota server is tokenless; --csrf_token is an IDE language-server flag and can exit agy immediately.
  const proc = pty.spawn(bin, [], { name: 'xterm-256color', cols: 100, rows: 30, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } });
  let exited = false;
  const exitEvent = proc.onExit(event => { exited = true; trace(`spawn exited code=${event?.exitCode ?? 'unknown'}`); });
  const dataEvent = proc.onData(() => {});
  const cleanup = () => { if (!exited) { try { proc.kill('SIGTERM'); } catch { /* Exited. */ } } };
  process.once('exit', cleanup);
  trace(`spawned pid=${proc.pid}`);
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
