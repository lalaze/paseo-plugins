import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const noop = () => {};
// React may schedule query GC after an unmount effect cleared its cache.
// Keep background/refetch intervals referenced, but do not wait five minutes for GC.
require('@tanstack/react-query').timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    if (delay >= 300000) timer.unref();
    return timer;
  },
  clearTimeout, setInterval, clearInterval,
});
for (const platform of ['android', 'ios', 'web']) {
  const runtimeRequire = name => name === 'react-native' ? {
    Modal: 'native-modal', Platform: { OS: platform }, View: 'view', Text: 'text', Pressable: 'pressable', ScrollView: 'scroll-view', TextInput: 'text-input',
    StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 400, height: 800 }),
  } : require(name);
  const contribute = (0, eval)(source)(runtimeRequire).default;
  const registrations = new Map(), calls = [], subscriptions = new Set();
  let opened, tree;
  const add = (kind, value) => { registrations.set(kind, value); return () => registrations.delete(kind); };
  const cleanup = contribute({
    paseo: { providers: {
      listUsage: () => assert.fail('Token usage must not query quotas'),
      subscribe: listener => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    }, workspaces: {
      list: async () => ({ entries: [{ id: 'workspace', archivingAt: null }], pageInfo: { hasMore: false } }),
      subscribe: listener => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    } },
    rpc: async (contract, input) => {
      calls.push(contract.name);
      if (contract.name === 'read-host-identity') return { id: 'test-host', label: 'Test host' };
      assert.match(contract.name, /^read-(workspace-)?consumption$/);
      return { range: input.range, scanning: false, sources: [{ source: 'codex', status: 'ready', updatedAt: new Date().toISOString(), message: null,
        rows: [{ date: new Intl.DateTimeFormat('en-CA', { timeZone: input.range.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), model: 'gpt-test', input: 1234567, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, inferredModel: false }] }] };
    },
    addHeaderButton: contribution => {
      registrations.set('header', contribution);
      return { update: patch => { contribution.button = { ...contribution.button, ...patch }; }, remove: () => registrations.delete('header') };
    },
    addSurface: (id, component) => add('surface', { id, component }),
    addSidebarItem: item => add('sidebar', item),
    addCommandCenterItem: item => add('command', item),
    openSurface: id => { opened = id; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.includes('read-consumption'), 'statistics warm up before opening the page');
    assert.equal(registrations.get('sidebar').surface, 'consumption');
    registrations.get('command').onSelect();
    assert.equal(opened, 'consumption');
    const props = {
      theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', surface0: '#111111', surface1: '#222222', surface2: '#333333', border: '#444', accent: '#acf', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } },
      host: { id: 'test-host', label: 'Test host' }, layout: { compact: platform !== 'web', platform },
    };
    const header = registrations.get('header');
    assert.equal(header.workspaceId, 'workspace');
    assert.match(header.button.label, /(?:Today|今日) 1\.23M/);
    header.button.behavior.onPress();
    assert.equal(opened, 'consumption');
    let icon;
    await act(async () => { icon = create(React.createElement(header.button.icon, { ...props, size: 16 })); });
    assert.equal(icon.root.findAllByType('view')[1].props.style.backgroundColor, '#0f0');
    await act(async () => { icon.unmount(); });
    await act(async () => {
      tree = create(React.createElement(registrations.get('surface').component, props));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const text = tree.root.findAllByType('text').map(node => node.props.children).flat().join(' ');
    assert.match(text, /Token Usage|Token 消耗/);
    assert.match(text, /Codex/);
    assert.match(text, /1[,.]234[,.]667/, 'page shows input + output from the consumption RPC');
  } finally {
    await act(async () => { tree?.unmount(); });
    cleanup();
  }
  assert.equal(registrations.size, 0, 'unload removes all entry points');
  assert.equal(subscriptions.size, 0, 'unload stops provider subscriptions');
  console.log(`PASS ${platform}: today's usage header and statistics render without quota integration and clean up`);
}
const serverSource = await readFile(new URL('../dist/server.js', import.meta.url), 'utf8');
const handlers = new Map();
const dispose = (0, eval)(serverSource)(require).default({
  handle: (contract, handler) => handlers.set(contract.name, handler),
  registerSettings: () => assert.fail('Quota preferences must not be registered'),
  registerUsageSource: () => assert.fail('Quota readers must not be registered'),
});
try {
  assert.deepEqual([...handlers.keys()].sort(), ['read-consumption', 'read-host-identity', 'read-workspace-consumption']);
} finally { dispose(); }
console.log('PASS server: only token consumption and host identity RPCs are registered');
