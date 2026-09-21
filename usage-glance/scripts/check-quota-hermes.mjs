import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the shipped bundle through Hermes eval, including the actual workspace
// registration loop. Node alone does not reproduce Hermes's loop capture bug.
// HERMES_BIN=/path/to/hermes node usage-glance/scripts/check-quota-hermes.mjs
assert.ok(process.env.HERMES_BIN, 'Set HERMES_BIN to the Hermes CLI executable');
const source = await readFile(process.argv[2] ?? new URL('../dist/client.js', import.meta.url), 'utf8');
const directory = await mkdtemp(join(tmpdir(), 'paseo-quota-hermes-'));
try {
  const path = join(directory, 'probe.js');
  await writeFile(path, `
    function noop() {}
    function identity(value) { return value; }
    globalThis.setInterval = noop;
    globalThis.clearInterval = noop;
    globalThis.Intl = { DateTimeFormat: function() { return {
      resolvedOptions: function() { return { timeZone: 'UTC' }; },
      format: function() { return '2026-09-21'; },
      formatToParts: function() { return [
        { type: 'year', value: '2026' }, { type: 'month', value: '09' }, { type: 'day', value: '21' }
      ]; }
    }; } };
    var refs = {}, currentWorkspace;
    var react = {
      useEffect: noop,
      useRef: function() { return refs[currentWorkspace] || (refs[currentWorkspace] = { current: {} }); },
      useLayoutEffect: function(effect) { effect(); },
      useSyncExternalStore: function(subscribe, snapshot) { return snapshot(); }
    };
    function element(type, props) { return { type: type, props: props }; }
    function QueryClient() {}
    QueryClient.prototype.mount = QueryClient.prototype.unmount = QueryClient.prototype.clear = noop;
    QueryClient.prototype.getQueryCache = function() { return { subscribe: function() { return noop; }, findAll: function() { return []; } }; };
    function QueryObserver() {}
    QueryObserver.prototype.subscribe = function() { return noop; };
    QueryObserver.prototype.getCurrentResult = function() { return { isPending: true }; };
    QueryObserver.prototype.destroy = noop;
    var schema = new Proxy(function() { return schema; }, { get: function() { return schema; } });
    function runtimeRequire(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' };
      if (name === 'react-native') return { Platform: { OS: 'android' }, StyleSheet: { create: identity } };
      if (name === '@getpaseo/plugin/client/react-native') return {};
      if (name === 'zod') return { z: schema };
      if (name === '@getpaseo/plugin') return { defineRpc: identity, defineSettings: identity, settingsRpc: function() { return {}; } };
      if (name === '@tanstack/react-query') return { QueryClient: QueryClient, QueryObserver: QueryObserver, queryOptions: identity };
      throw Error('Unexpected module ' + name);
    }
    var buttons = {}, ids = ['first', 'middle', 'last'];
    var cleanup = globalThis.eval(${JSON.stringify(source)})(runtimeRequire).default({
      paseo: {
        providers: { subscribe: function() { return noop; } },
        workspaces: {
          subscribe: function() { return noop; },
          list: function() { return Promise.resolve({ entries: ids.map(function(id) { return { id: id }; }), pageInfo: { hasMore: false } }); }
        }
      },
      rpc: function() { return Promise.resolve({}); },
      addSurface: function() { return noop; }, addSidebarItem: function() { return noop; }, addCommandCenterItem: function() { return noop; },
      addHeaderButton: function(entry) {
        buttons[entry.workspaceId] = entry.button;
        return { update: noop, remove: noop };
      }
    });
    Promise.resolve().then(function() {
      if (Object.keys(buttons).length !== ids.length) throw Error('missing workspace buttons');
      ids.forEach(function(id) {
        currentWorkspace = id;
        var button = buttons[id], props = { workspaceId: id, host: { id: 'test' } };
        button.icon(props); // Mount the workspace presenter.
        for (var attempt = 0; attempt < 3; attempt++) {
          button.behavior.onPress();
          if (!button.icon(props).props.children[1]) throw Error('quota failed to open in ' + id);
          button.behavior.onPress();
          if (button.icon(props).props.children[1]) throw Error('quota failed to close in ' + id);
        }
      });
      cleanup();
      print('PASS Hermes: quota callbacks target each of three workspaces');
    }).catch(function(error) { print(error.stack); });
  `);
  const result = spawnSync(process.env.HERMES_BIN, ['-Xes6-class', path], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PASS Hermes: quota callbacks target each of three workspaces', result.stdout + result.stderr);
  console.log(result.stdout.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
