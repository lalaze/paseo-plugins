import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let hub, base, token, tempDir, starting;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function teardownHub() {
  const child = hub;
  const dir = tempDir;
  hub = base = token = tempDir = undefined;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (dir) await rm(dir, { recursive: true, force: true });
}

async function startHub() {
  if (starting) return starting;
  let attempt;
  attempt = (async () => {
    try {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      tempDir = await mkdtemp(join(tmpdir(), 'agy-hub-acp-'));
      base = `http://127.0.0.1:${port}`;
      hub = spawn(process.env.AGY_HUB_BIN || join(homedir(), '.gemini/bin/agy'), ['--hub', `--hub-port=${port}`, '--app_data_dir=antigravity', `--log-file=${join(tempDir, 'hub.log')}`], {
        cwd: tempDir, env: { ...process.env, AGY_ENABLE_HUB: '1', ANTIGRAVITY_VSCODE_HOST: '1' }, stdio: 'ignore',
      });
      let launchError;
      hub.on('error', error => { launchError = error; });
      for (let i = 0; i < 120; i++) {
        if (launchError) throw launchError;
        if (hub.exitCode !== null) throw new Error(`Hub exited (${hub.exitCode})`);
        try {
          const res = await fetch(base, { signal: AbortSignal.timeout(1000) });
          const html = await res.text();
          const match = html.match(/window\.__APP_CONFIG__ = (.*?);/);
          if (match) {
            token = JSON.parse(match[1]).csrfToken;
            const child = hub;
            const dir = tempDir;
            child.once('exit', () => {
              if (hub === child) {
                hub = base = token = tempDir = undefined;
                starting = undefined;
              }
              rm(dir, { recursive: true, force: true }).catch(() => {});
            });
            return;
          }
        } catch {}
        await delay(250);
      }
      throw new Error('Hub startup timed out');
    } catch (error) {
      await teardownHub();
      if (starting === attempt) starting = undefined;
      throw error;
    }
  })();
  starting = attempt;
  return attempt;
}
export async function rpc(method, body, signal) {
  await startHub();
  const res = await fetch(`${base}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': token },
    body: JSON.stringify(body), signal: signal || AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method}: ${data.message || res.status}`);
  return data;
}
export async function* updates(s, signal) {
  await startHub();
  const data = Buffer.from(JSON.stringify({ conversationId: s.id, subscriberId: randomUUID(), initialStepsPageBounds: { startIndex: -100 }, initialGeneratorMetadatasPageBounds: { startIndex: -1 }, initialExecutorMetadatasPageBounds: { endIndexExclusive: 0 } }));
  const head = Buffer.alloc(5); head.writeUInt32BE(data.length, 1);
  const res = await fetch(`${base}/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates`, {
    method: 'POST', headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token }, body: Buffer.concat([head, data]), signal,
  });
  if (!res.ok) throw new Error(`Hub stream HTTP ${res.status}`);
  let buffer = Buffer.alloc(0);
  for await (const chunk of res.body) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const len = buffer.readUInt32BE(1);
      if (len > 64 * 1024 * 1024) throw new Error('Hub frame exceeds limit');
      if (buffer.length < len + 5) break;
      const flags = buffer[0], frame = JSON.parse(buffer.subarray(5, len + 5).toString());
      buffer = buffer.subarray(len + 5);
      if (flags & 2) { if (frame.error) throw new Error(frame.error.message); return; }
      if (flags & 1) throw new Error('Unsupported compressed Hub frame');
      if (frame.update) yield frame.update;
    }
  }
}

export async function stopHub() {
  starting = undefined;
  await teardownHub();
}
