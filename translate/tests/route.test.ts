import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConversationRoute } from '../client/route';

test('parses a dedicated agent route', () => {
  assert.deepEqual(parseConversationRoute('/h/local%20host/agent/agent%2Fone'), { serverId: 'local host', agentId: 'agent/one' });
});

test('parses the focused agent in a workspace route', () => {
  assert.deepEqual(parseConversationRoute('/h/server/workspace/wks_1', '?open=agent%3Aabc-123'), { serverId: 'server', agentId: 'abc-123' });
});

test('supports hash-based desktop routing and ignores unrelated pages', () => {
  assert.deepEqual(parseConversationRoute('/', '', '#/h/server/agent/abc'), { serverId: 'server', agentId: 'abc' });
  assert.equal(parseConversationRoute('/settings'), null);
});
