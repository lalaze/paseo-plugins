import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the token-only contribution through the mobile dynamic eval boundary.
// HERMES_BIN=/path/to/hermes node usage-glance/scripts/check-consumption-hermes.mjs
assert.ok(process.env.HERMES_BIN, 'Set HERMES_BIN to the Hermes CLI executable');
const source = await readFile(process.argv[2] ?? new URL('../dist/client.js', import.meta.url), 'utf8');
const directory = await mkdtemp(join(tmpdir(), 'paseo-consumption-hermes-'));
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
    var react = {};
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
    var active = 0, subscriptions = 0, command, opened;
    function register() { active++; return function() { active--; }; }
    var cleanup = globalThis.eval(${JSON.stringify(source)})(runtimeRequire).default({
      paseo: { providers: {
        subscribe: function() { subscriptions++; return function() { subscriptions--; }; },
        listUsage: function() { throw Error('unexpected quota query'); }
      }, workspaces: {
        list: function() { return Promise.resolve({ entries: [{ id: 'workspace' }], pageInfo: { hasMore: false } }); },
        subscribe: function() { subscriptions++; return function() { subscriptions--; }; }
      } },
      rpc: function(contract) {
        if (contract.name !== 'read-host-identity') throw Error('unexpected RPC');
        return Promise.resolve({ id: 'test', label: 'Phone' });
      },
      addSurface: register, addSidebarItem: register,
      addCommandCenterItem: function(item) { command = item; return register(); },
      openSurface: function(id) { opened = id; },
      addHeaderButton: function(value) {
        if (value.id !== 'today-consumption' || value.workspaceId !== 'workspace') throw Error('missing usage header');
        if (value.button.label.indexOf('—') === -1) throw Error('missing data displayed as zero');
        var remove = register(); return { update: noop, remove: remove };
      }
    });
    Promise.resolve().then(function() {
      if (active !== 4 || subscriptions !== 3) throw Error('missing consumption registrations');
      command.onSelect();
      if (opened !== 'consumption') throw Error('consumption navigation');
      cleanup();
      if (active !== 0 || subscriptions !== 0) throw Error('consumption cleanup');
      print('PASS Hermes: token consumption entry points and cleanup');
    }).catch(function(error) { print(error.stack); });
  `);
  const result = spawnSync(process.env.HERMES_BIN, ['-Xes6-class', path], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PASS Hermes: token consumption entry points and cleanup', result.stdout + result.stderr);
  console.log(result.stdout.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
