#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { locate as locateServer } from './notification-patch.mjs';

// Move only the matching settings button; preserve other buttons and their state.
export function orderHeaderButtons(entries) {
  const ordered = [...entries];
  for (const quota of entries) {
    if (quota.placement !== 'header' || quota.installation.id !== 'paseo-usage-glance' || quota.id !== 'usage') continue;
    const settingsIndex = ordered.findIndex(entry => entry.placement === 'header'
      && entry.installation.id === 'paseo-director' && entry.id === 'director-settings'
      && entry.installation.serverId === quota.installation.serverId
      && entry.context.workspaceId === quota.context.workspaceId);
    if (settingsIndex < 0 || settingsIndex > ordered.indexOf(quota)) continue;
    const [settings] = ordered.splice(settingsIndex, 1);
    ordered.splice(ordered.indexOf(quota) + 1, 0, settings);
  }
  return ordered;
}

const anchor = 'publish(t){this.entries=t;for(const t of this.listeners)t()}';
const marker = '/*paseo-director:header-order:v1*/';
const replacement = `publish(t){this.entries=${marker}(${orderHeaderButtons.toString()})(t);for(const t of this.listeners)t()}`;
export function transform(source, rollback = false) {
  if (!source.includes('addHeaderButton(t,n){return this.add(t,n,"header",')) throw new Error('Paseo button store changed; patch refused');
  const installed = source.includes(marker);
  const from = installed ? replacement : anchor;
  if (source.split(from).length !== 2) throw new Error('Paseo button ordering anchor changed; patch refused');
  return source.replace(from, rollback ? anchor : replacement);
}

export function locate(cli) {
  const server = locateServer(cli);
  const directory = join(dirname(dirname(server.path)), 'web-ui/_expo/static/js/web');
  const files = readdirSync(directory).filter(name => /^index-.*\.js$/.test(name))
    .map(name => join(directory, name)).filter(path => readFileSync(path, 'utf8').includes('addHeaderButton(t,n){return this.add(t,n,"header",'));
  if (files.length !== 1) throw new Error('Expected one Paseo web button bundle; patch refused');
  return { path: files[0], version: server.version };
}

export function update(path, command) {
  const source = readFileSync(path, 'utf8');
  const next = transform(source, command === 'rollback');
  new Script(next, { filename: path });
  const changed = command !== 'check' && source !== next;
  if (changed) {
    const temp = `${path}.director-${process.pid}.tmp`;
    writeFileSync(temp, next, { mode: statSync(path).mode & 0o777 });
    renameSync(temp, path);
  }
  return { path, compatible: true, changed, installed: (command === 'check' ? source : next).includes(marker) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, flag, cli] = process.argv.slice(2);
    if (!['check', 'apply', 'rollback'].includes(command) || (flag && (flag !== '--cli' || !cli || process.argv.length !== 5))) throw new Error('Usage: node header-order-patch.mjs check|apply|rollback [--cli /path/to/@getpaseo/cli]');
    const target = locate(cli);
    console.log(JSON.stringify({ ...update(target.path, command), version: target.version }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
