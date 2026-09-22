#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { locatePaseoInstallation } from '../../scripts/paseo-installation.mjs';
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
];
// 0.9 selects recipients from notification subscribers, not all event subscribers.
const recipientReplacements = [
  ['            const shouldNotify = clientIndex === plan.inAppRecipientIndex;', '            const shouldNotify = !directorMuteFinished && clientIndex === plan.inAppRecipientIndex;'],
  ['            const shouldNotify = plan.inAppRecipientIndex !== null &&\n                notificationEntries[plan.inAppRecipientIndex]?.ws === ws;', '            const shouldNotify = !directorMuteFinished && plan.inAppRecipientIndex !== null &&\n                notificationEntries[plan.inAppRecipientIndex]?.ws === ws;'],
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
  const recipients = recipientReplacements.filter(pair => body.includes(pair[rollback ? 1 : 0]));
  if (recipients.length !== 1) throw new Error('Paseo notification recipient anchor changed; patch refused');
  for (const pair of [...replacements, ...recipients]) {
    const [from, to] = rollback ? [pair[1], pair[0]] : pair;
    if (body.split(from).length !== 2) throw new Error('Paseo notification anchor changed; patch refused');
    body = body.replace(from, to);
  }
  return source.slice(0, start) + body + source.slice(stop);
}

export function locate(cliOverride) {
  const { server, version } = locatePaseoInstallation(cliOverride);
  if (!/^0\.(8|9)\./.test(version)) throw new Error(`Unsupported Paseo version ${version}`);
  return { path: join(server, 'dist/server/server/websocket-server.js'), version };
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
