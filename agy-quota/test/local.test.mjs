import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listeningPorts, requestQuota, parseLsofListenPorts, parseLsofTxtPids, csrfFromCommand, parseAppConfigCsrf, csrfFromOwnedPorts, exeLinkPath } from '../src/antigravity-local.js';

const dir = mkdtempSync(join(tmpdir(), 'agy-local-api-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const options = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };

test('process-owned local TLS API: auth header, body, errors and bounded reads', async () => {
  const server = createServer(options, (req, res) => {
    const method = req.url.split('/').pop();
    if (method === 'Hang') return;
    if (req.headers['x-codeium-csrf-token'] !== 'test-csrf') { res.writeHead(401); res.end(); return; }
    if (method === 'Oversize') { res.end('x'.repeat(1024 * 1024 + 1)); return; }
    if (method === 'Malformed') { res.end('invalid'); return; }
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => res.end(JSON.stringify({ metadata: JSON.parse(body).metadata, protocol: req.headers['connect-protocol-version'] })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.ok((await listeningPorts(process.pid)).includes(port));
    assert.equal(await requestQuota(port, 'GetUserStatus', undefined, 500), null);
    const data = await requestQuota(port, 'GetUserStatus', 'test-csrf', 500);
    assert.equal(data.metadata.ideName, 'antigravity');
    assert.equal(data.protocol, '1');
    assert.equal(await requestQuota(port, 'Oversize', 'test-csrf', 500), null);
    assert.equal(await requestQuota(port, 'Malformed', 'test-csrf', 500), null);
    const start = Date.now();
    assert.equal(await requestQuota(port, 'Hang', 'test-csrf', 100), null);
    assert.ok(Date.now() - start < 1000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('macOS lsof/ps parsers stay process-scoped and recover csrf tokens', () => {
  assert.deepEqual(parseLsofListenPorts('p9\nn127.0.0.1:41234\nn[::1]:41234\nn*:80\nn192.168.1.5:9 (LISTEN)\n'), [41234, 80, 9]);
  assert.deepEqual(parseLsofListenPorts(''), []);
  assert.deepEqual(parseLsofTxtPids('p11\nftxt\nn/bin/agy\np12\nfcwd\nn/tmp\np13\nftxt\nn/bin/agy\n'), [11, 13]);
  assert.equal(csrfFromCommand('agy --csrf_token=abc-123 other'), 'abc-123');
  assert.equal(csrfFromCommand(['agy', '--csrf_token', 'xyz']), 'xyz');
  assert.equal(csrfFromCommand('agy'), undefined);
});

test('quota probe accepts loopback IPv6 host argument without throwing', async () => {
  assert.equal(await requestQuota(1, 'GetUserStatus', undefined, 50, '::1'), null);
});

test('hub page csrf is read only from process-owned loopback ports', async () => {
  assert.equal(parseAppConfigCsrf('<script>window.__APP_CONFIG__ = {"csrfToken":"abc"};</script>'), 'abc');
  assert.equal(parseAppConfigCsrf('<html></html>'), undefined);
  assert.equal(parseAppConfigCsrf('<script>window.__APP_CONFIG__ = {"csrfToken":""};</script>'), undefined);
  assert.equal(exeLinkPath('/root/.gemini/bin/agy (deleted)'), '/root/.gemini/bin/agy');
  assert.equal(exeLinkPath('/root/.gemini/bin/agy'), '/root/.gemini/bin/agy');
  const server = createHttpServer((req, res) => {
    res.end('<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"hub-csrf-token"};</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await csrfFromOwnedPorts([port], 500), 'hub-csrf-token');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
