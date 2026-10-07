import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SharedTools, type Paseo } from '../server/service';

let home: string;
let tools: SharedTools;

const entries = [
  { provider: 'claude', status: 'ready', enabled: true, label: 'Claude' },
  { provider: 'pi', status: 'ready', enabled: true, label: 'Pi' },
  { provider: 'kimi', status: 'ready', enabled: true, label: 'Kimi' },
  { provider: 'codex', status: 'ready', enabled: false, label: 'Codex' },
];
const paseo = {
  providers: { snapshot: async () => ({ entries }) },
  config: { get: async () => ({ requestId: 'r', config: { providers: { kimi: { extends: 'acp', command: ['/opt/kimi/bin/kimi', 'acp'] } } } }) },
} as unknown as Paseo;

async function skill(dir: string, name: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\ndescription: ${name}\n---\n`);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'shared-tools-home-'));
  tools = new SharedTools(join(home, '.paseo/shared-tools'), home);
});
afterEach(async () => {
  tools.stop();
  await rm(home, { recursive: true, force: true });
});

test('lists Paseo\'s enabled providers with their skill folders and MCP defaults', async () => {
  const state = await tools.state(paseo);
  assert.deepEqual(state.providers.map(p => [p.id, p.present, p.mcp, p.skillsDir]), [
    ['claude', true, true, join(home, '.claude/skills')],
    ['kimi', true, true, join(home, '.kimi-code/skills')],
    ['pi', true, false, join(home, '.pi/agent/skills')],
  ]);
  assert.match(state.providers.find(p => p.id === 'pi')!.mcpNote!, /pi-mcp-adapter/);
});

test('hands shared servers to new agents of providers with MCP on', async () => {
  await tools.state(paseo);
  const { imported } = await tools.importServers('json', JSON.stringify({ mcpServers: { docs: { url: 'https://d/mcp' }, fs: { command: 'fs-mcp' } } }), false);
  assert.deepEqual(imported, ['docs', 'fs']);
  assert.deepEqual(await tools.mcpFor('claude', { fs: { type: 'stdio', command: 'mine' } }, paseo), { docs: { type: 'http', url: 'https://d/mcp' } });
  assert.equal(await tools.mcpFor('pi', undefined, paseo), null);

  await tools.updateProvider({ provider: 'pi', mcp: true });
  assert.deepEqual(Object.keys((await tools.mcpFor('pi', undefined, paseo))!).sort(), ['docs', 'fs']);

  const state = await tools.saveServer({ previousName: 'fs', name: 'files', enabled: false, providers: null, config: { type: 'stdio', command: 'fs-mcp' } });
  assert.deepEqual(state.mcpServers.map(s => [s.name, s.enabled]), [['docs', true], ['files', false]]);
  assert.deepEqual(Object.keys((await tools.mcpFor('claude', undefined, paseo))!), ['docs']);
  await assert.rejects(tools.saveServer({ previousName: null, name: 'paseo', enabled: true, providers: null, config: { type: 'stdio', command: 'x' } }), /reserved/);
});

test('a hand-edited entry it cannot read is reported and kept', async () => {
  await mkdir(join(home, '.paseo/shared-tools'), { recursive: true });
  await writeFile(join(home, '.paseo/shared-tools/config.json'), JSON.stringify({ mcpServers: { odd: { type: 'ws', url: 'ws://x' }, ok: { command: 'ok' } } }));
  const state = await tools.state(paseo);
  assert.deepEqual(state.mcpServers.map(s => s.name), ['ok']);
  assert.match(state.notes.join('\n'), /"odd" is skipped/);
  await tools.deleteServer('ok');
  const saved = JSON.parse(await readFile(join(home, '.paseo/shared-tools/config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.mcpServers), ['odd']);
  assert.equal((await stat(join(home, '.paseo/shared-tools/config.json'))).mode & 0o777, 0o600);
});

test('copies the library into each provider\'s folder and offers their own skills for import', async () => {
  await skill(join(home, '.paseo/shared-tools/skills'), 'tdd');
  await skill(join(home, '.claude/skills'), 'frontend-design');
  let state = await tools.state(paseo);
  for (const dir of ['.claude/skills', '.kimi-code/skills', '.pi/agent/skills']) {
    assert.ok((await readdir(join(home, dir))).includes('tdd'), dir);
  }
  assert.deepEqual(state.skills[0]!.targets.map(t => [t.provider, t.status]), [['claude', 'synced'], ['kimi', 'synced'], ['pi', 'synced']]);
  assert.deepEqual(state.found.map(f => [f.name, f.provider]), [['frontend-design', 'claude']]);

  state = await tools.importSkill(state.found[0]!.path, false);
  assert.deepEqual(state.skills.map(s => s.name), ['frontend-design', 'tdd']);
  assert.ok((await readdir(join(home, '.pi/agent/skills'))).includes('frontend-design'));
  assert.deepEqual(state.found, []);

  state = await tools.updateProvider({ provider: 'pi', skills: false });
  assert.deepEqual(await readdir(join(home, '.pi/agent/skills')), []);
  assert.deepEqual(state.skills[0]!.targets.map(t => t.provider), ['claude', 'kimi']);
});

test('a provider seen for the first time at agent creation gets its skills first', async () => {
  await skill(join(home, '.paseo/shared-tools/skills'), 'tdd');
  await tools.mcpFor('claude', undefined, paseo);
  assert.ok((await readdir(join(home, '.claude/skills'))).includes('tdd'));
});
