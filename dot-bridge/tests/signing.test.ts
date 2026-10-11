import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSecret, signPayload, signPayloadMulti, verifyPayload, webhookHeaders } from '../server/signing';

describe('Standard Webhooks signing', () => {
  it('verifies a signature over the exact body', () => {
    const secret = generateSecret();
    assert.ok(secret.startsWith('whsec_'));
    const payload = JSON.stringify({ eventId: 'e1', type: 'paseo.dot.task_changed' });
    const headers = webhookHeaders(secret, 'msg-1', '1700000000', payload);
    assert.equal(verifyPayload(secret, headers, payload, 1700000000), true);
    assert.equal(verifyPayload(secret, headers, `${payload} `, 1700000000), false);
  });

  it('rejects a tampered signature and an out-of-tolerance timestamp', () => {
    const secret = generateSecret();
    const payload = '{"a":1}';
    const headers = webhookHeaders(secret, 'msg-2', '1700000000', payload);
    assert.equal(verifyPayload(secret, { ...headers, signature: 'v1,AAAA' }, payload, 1700000000), false);
    assert.equal(verifyPayload(secret, headers, payload, 1700001000), false);
  });

  it('accepts one of several space-separated signatures', () => {
    const secret = generateSecret();
    const payload = '{"a":2}';
    const good = signPayload(secret, 'msg-3', '1700000000', payload);
    const headers = { id: 'msg-3', timestamp: '1700000000', signature: `v1,AAAA ${good}` };
    assert.equal(verifyPayload(secret, headers, payload, 1700000000), true);
  });

  it('signs with both the new and the previous secret during a rotation window', () => {
    const current = generateSecret();
    const previous = generateSecret();
    const payload = '{"a":3}';
    const signature = signPayloadMulti([current, previous], 'msg-4', '1700000000', payload);
    assert.equal(signature.split(' ').length, 2);
    assert.equal(verifyPayload(current, { id: 'msg-4', timestamp: '1700000000', signature }, payload, 1700000000), true);
    assert.equal(verifyPayload(previous, { id: 'msg-4', timestamp: '1700000000', signature }, payload, 1700000000), true);
  });
});
