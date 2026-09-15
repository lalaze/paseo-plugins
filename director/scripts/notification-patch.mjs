#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { shouldMuteDirectorFinish } from './notification-policy.mjs';

const begin = '    async broadcastAgentAttention(params) {';
const end = '    async broadcastTerminalAttention(params) {';
const marker = '        // paseo-director:quiet-notifications:v1\n';
const injection = marker + `        const directorMuteFinished = (${shouldMuteDirectorFinish.toString()})(agent, params.reason, this.agentManager.getTimeline(params.agentId));\n`;
const replacements = [
  ['        const clientEntries = [];', injection + '        const clientEntries = [];'],
  ['        if (plan.shouldPush) {', '        if (plan.shouldPush && !directorMuteFinished) {'],
  ['            const shouldNotify = clientIndex === plan.inAppRecipientIndex;', '            const shouldNotify = !directorMuteFinished && clientIndex === plan.inAppRecipientIndex;'],
];

export function transform(source, rollback = false) {
  const start = source.indexOf(begin), stop = source.indexOf(end, start);
  if (start < 0 || stop < 0 || source.indexOf(begin, start + begin.length) >= 0) throw new Error('Paseo notification dispatcher changed; patch refused');
  const installed = source.includes(marker);
  if (installed !== rollback) {
    // An existing patch must still be exactly reversible before treating it as installed.
    if (installed) transform(source, true);
    return source;
  }
  let body = source.slice(start, stop);
  for (const pair of replacements) {
    const [from, to] = rollback ? [pair[1], pair[0]] : pair;
    if (body.split(from).length !== 2) throw new Error('Paseo notification anchor changed; patch refused');
    body = body.replace(from, to);
  }
  return source.slice(0, start) + body + source.slice(stop);
}

export function locate(cliOverride) {
  const candidates = cliOverride ? [resolve(cliOverride)] : (process.env.PATH ?? '').split(delimiter).map(path => join(path, 'paseo')).filter(existsSync).map(path => dirname(dirname(realpathSync(path))));
  for (const cli of candidates) {
    try {
      if (JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).name !== '@getpaseo/cli') continue;
      let server = dirname(createRequire(join(cli, 'package.json')).resolve('@getpaseo/server'));
      while (!existsSync(join(server, 'package.json'))) { const parent = dirname(server); if (parent === server) throw new Error('Paseo package not found'); server = parent; }
      const version = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8')).version;
      if (!/^0\.8\./.test(version)) throw new Error(`Unsupported Paseo version ${version}`);
      return { path: join(server, 'dist/server/server/websocket-server.js'), version };
    } catch (error) { if (cliOverride || error.message.startsWith('Unsupported')) throw error; }
  }
  throw new Error('Paseo CLI not found; pass --cli /path/to/@getpaseo/cli');
}

export function update(path, command) {
  const source = readFileSync(path, 'utf8');
  const installed = source.includes(marker);
  const next = transform(source, command === 'rollback');
  // Parse the complete real host module before any write.
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
  if (command !== 'check' && next !== source) {
    const temp = `${path}.director-${process.pid}.tmp`;
    writeFileSync(temp, next, { mode: statSync(path).mode & 0o777 }); renameSync(temp, path);
  }
  return { installed: command === 'check' ? installed : next.includes(marker), changed: command !== 'check' && next !== source, compatible: true, path };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, flag, cli] = process.argv.slice(2);
    if (!['check', 'apply', 'rollback'].includes(command) || (flag && (flag !== '--cli' || !cli || process.argv.length !== 5))) throw new Error('Usage: node notification-patch.mjs check|apply|rollback [--cli /path/to/@getpaseo/cli]');
    const target = locate(cli);
    console.log(JSON.stringify({ ...update(target.path, command), version: target.version }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
