import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCallbackUrl, isPrivateAddress, parseRetryAfter, postSigned } from '../server/http';

describe('callback address policy', () => {
  it('classifies private and public addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('refuses reserved, documentation and IPv4-mapped-IPv6 ranges', () => {
    for (const address of ['0.0.0.0', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1', 'ff02::1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    assert.equal(isPrivateAddress('not-an-address'), true);
  });

  it('cannot be bypassed with an expanded IPv6 spelling', () => {
    for (const address of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '2001:0db8:0:0:0:0:0:1', 'fd00:0000:0000:0000:0000:0000:0000:0001', 'fe80:0000:0000:0000:0000:0000:0000:0001']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['2001:4860:0:0:0:0:0:1', '2606:4700:4700:0:0:0:0:1111', '0:0:0:0:0:ffff:0808:0808']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('parses Retry-After as seconds or an HTTP-date', () => {
    assert.equal(parseRetryAfter('5'), 5);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('nonsense'), null);
    assert.equal(parseRetryAfter(null), null);
  });

  it('refuses non-HTTPS and private targets', async () => {
    assert.deepEqual(await checkCallbackUrl('http://example.com/hook'), { ok: false, reason: 'not-https' });
    assert.deepEqual(await checkCallbackUrl('https://localhost/hook'), { ok: false, reason: 'private-address' });
    const privateLookup = async () => ['10.0.0.1'];
    assert.equal((await checkCallbackUrl('https://example.com/hook', privateLookup)).ok, false);
    const publicLookup = async () => ['93.184.216.34'];
    const publicCheck = await checkCallbackUrl('https://example.com/hook', publicLookup);
    assert.equal(publicCheck.ok, true);
    assert.equal(publicCheck.address, '93.184.216.34');
  });

  it('allows Clash fake-IP resolution for the OpenAI callback and pins the resolved address', async () => {
    for (const address of ['198.18.0.20', '198.19.255.254']) {
      assert.deepEqual(await checkCallbackUrl('https://connectors.api.openai.com/hook', async () => [address]), { ok: true, address });
    }
  });

  it('does not extend the fake-IP exception to other hosts, ports, credentials or IP literals', async () => {
    for (const url of [
      'https://example.com/hook',
      'https://connectors.api.openai.com.example.com/hook',
      'https://other.connectors.api.openai.com/hook',
      'https://connectors.api.openai.com:8443/hook',
      'https://user:password@connectors.api.openai.com/hook',
      'http://connectors.api.openai.com/hook',
      'https://198.18.0.20/hook',
    ]) {
      assert.equal((await checkCallbackUrl(url, async () => ['198.18.0.20'])).ok, false, url);
    }
  });

  it('still rejects local, reserved and mixed DNS answers for the OpenAI callback', async () => {
    for (const addresses of [
      ['127.0.0.1'], ['10.0.0.1'], ['192.168.1.1'], ['169.254.169.254'], ['100.64.0.1'],
      ['::1'], ['fd00::1'], ['198.51.100.1'], ['198.18.0.20', '127.0.0.1'],
      ['93.184.216.34', '192.168.1.1'],
    ]) {
      assert.deepEqual(await checkCallbackUrl('https://connectors.api.openai.com/hook', async () => addresses), { ok: false, reason: 'private-address' });
    }
  });
});

describe('bounded POST', () => {
  it('disables redirects, bounds the timeout and returns the response body', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ challenge: 'echo' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await postSigned('https://example.com/hook', '{}', {}, fetchImpl);
    assert.equal(result.status, 200);
    assert.equal(result.text, JSON.stringify({ challenge: 'echo' }));
    assert.equal(seen?.redirect, 'error');
    assert.ok(seen?.signal);
  });

  it('reports a transport error as status 0', async () => {
    const fetchImpl = async () => {
      throw new Error('connection refused');
    };
    const result = await postSigned('https://example.com/hook', '{}', {}, fetchImpl);
    assert.equal(result.status, 0);
    assert.match(result.error ?? '', /connection refused/);
  });
});
