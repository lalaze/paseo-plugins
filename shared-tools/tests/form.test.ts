import assert from 'node:assert/strict';
import { test } from 'node:test';
// The messages follow the host's language; pin it so a Chinese host runs the same assertions.
(globalThis as { __PASEO_LOCALE__?: string }).__PASEO_LOCALE__ = 'en';
import { blankDraft, draftFrom, matchesQuery, serverFromDraft, summarize } from '../shared/form';

test('turns a stdio draft into a server and back', () => {
  const result = serverFromDraft({ ...blankDraft(), name: 'fs', command: ' npx ', args: '-y\n\n@scope/fs\n', env: 'ROOT=/a=b\n' });
  assert.ok('server' in result);
  assert.deepEqual(result.server.config, { type: 'stdio', command: 'npx', args: ['-y', '@scope/fs'], env: { ROOT: '/a=b' } });
  assert.equal(summarize(result.server.config), 'npx -y @scope/fs');
  assert.deepEqual(serverFromDraft(draftFrom(result.server)), result);
});

test('keeps the colon inside header values', () => {
  const result = serverFromDraft({ ...blankDraft(), name: 'docs', type: 'http', url: 'https://d/mcp', headers: 'Authorization: Bearer a:b' });
  assert.ok('server' in result);
  assert.deepEqual(result.server.config, { type: 'http', url: 'https://d/mcp', headers: { Authorization: 'Bearer a:b' } });
});

test('names the first problem', () => {
  const error = (patch: Partial<ReturnType<typeof blankDraft>>) => { const r = serverFromDraft({ ...blankDraft(), name: 'x', command: 'c', ...patch }); return 'error' in r ? r.error : null; };
  assert.match(error({ name: 'has space' })!, /Name/);
  assert.match(error({ command: ' ' })!, /Command/);
  assert.match(error({ env: 'NOVALUE' })!, /Environment/);
  assert.match(error({ type: 'sse', url: 'ftp://x' })!, /URL/);
  assert.equal(error({}), null);
});

test('matches every word of a search across name, description and provider', () => {
  assert.ok(matchesQuery('', 'anything'));
  assert.ok(matchesQuery('  FRONT design ', 'frontend-design', 'Create distinctive interfaces'));
  assert.ok(matchesQuery('claude front', 'frontend-design', undefined, 'Claude'));
  assert.ok(!matchesQuery('front codex', 'frontend-design', 'Claude'));
});


test('preserves empty allowlists and denylists through editing', () => {
  for (const access of [{ providers: [] }, { providers: null, excludedProviders: ['kimi', 'future-provider'] }]) {
    const result = serverFromDraft({ ...blankDraft(), name: 'fs', command: 'fs', ...access });
    assert.ok('server' in result);
    assert.deepEqual(serverFromDraft(draftFrom(result.server)), result);
    assert.deepEqual(result.server.providers, access.providers);
    assert.deepEqual(result.server.excludedProviders, 'excludedProviders' in access ? access.excludedProviders : undefined);
  }
});
