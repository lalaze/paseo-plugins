import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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


test('persists MCP allowlists and denylists across reloads, renames, and enable switches', async () => {
  await tools.state(paseo);
  let state = await tools.saveServer({ name: 'docs', previousName: null, enabled: true, providers: null, excludedProviders: ['kimi'], config: { type: 'http', url: 'https://d/mcp' } });
  assert.equal(await tools.mcpFor('kimi', undefined, paseo), null);
  assert.deepEqual(await tools.mcpFor('claude', undefined, paseo), { docs: { type: 'http', url: 'https://d/mcp' } });
  tools.stop();
  tools = new SharedTools(join(home, '.paseo/shared-tools'), home);
  state = await tools.state(paseo);
  assert.deepEqual(state.mcpServers[0]!.excludedProviders, ['kimi']);
  state = await tools.saveServer({ ...state.mcpServers[0]!, name: 'renamed', previousName: 'docs', enabled: false });
  state = await tools.saveServer({ ...state.mcpServers[0]!, previousName: 'renamed', enabled: true });
  assert.equal(await tools.mcpFor('kimi', undefined, paseo), null);
  await tools.saveServer({ ...state.mcpServers[0]!, previousName: 'renamed', providers: [], excludedProviders: [] });
  assert.equal(await tools.mcpFor('claude', undefined, paseo), null);
});

test('skill permissions apply per skill and survive reloads; empty allowlists remove managed copies', async () => {
  await skill(tools.libraryDir, 'restricted');
  await skill(tools.libraryDir, 'unrestricted');
  await tools.state(paseo);
  let state = await tools.updateSkillAccess({ name: 'restricted', providers: ['claude'] });
  assert.deepEqual(state.skills.find(s => s.name === 'restricted')!.targets.map(t => t.provider), ['claude']);
  for (const dir of ['.kimi-code/skills', '.pi/agent/skills']) {
    assert.deepEqual(await readdir(join(home, dir)), ['unrestricted']);
  }
  tools.stop();
  tools = new SharedTools(join(home, '.paseo/shared-tools'), home);
  state = await tools.state(paseo);
  assert.deepEqual(state.skills.find(s => s.name === 'restricted')!.providers, ['claude']);
  state = await tools.updateSkillAccess({ name: 'restricted', providers: null, excludedProviders: ['claude'] });
  assert.deepEqual(state.skills.find(s => s.name === 'restricted')!.targets.map(t => t.provider), ['kimi', 'pi']);
  assert.deepEqual(await readdir(join(home, '.claude/skills')), ['unrestricted']);
  state = await tools.updateSkillAccess({ name: 'restricted', providers: [] });
  assert.equal(state.skills.find(s => s.name === 'restricted')!.targets.length, 0);
  assert.deepEqual(await readdir(join(home, '.kimi-code/skills')), ['unrestricted']);
  state = await tools.updateSkillAccess({ name: 'restricted', providers: null });
  assert.equal(state.skills.find(s => s.name === 'restricted')!.targets.length, 3);
  await tools.updateProvider({ provider: 'pi', skills: false });
  state = await tools.updateSkillAccess({ name: 'restricted', providers: null, excludedProviders: ['kimi'] });
  assert.deepEqual(state.skills.find(s => s.name === 'restricted')!.targets.map(t => t.provider), ['claude']);
});

test('new providers follow allowlist and denylist rules', async () => {
  await skill(tools.libraryDir, 'allowed');
  await skill(tools.libraryDir, 'denied');
  await tools.state(paseo);
  await tools.updateSkillAccess({ name: 'allowed', providers: ['claude'] });
  await tools.updateSkillAccess({ name: 'denied', providers: null, excludedProviders: ['kimi'] });
  await tools.saveServer({ name: 'only', previousName: null, enabled: true, providers: ['claude'], config: { type: 'stdio', command: 'only' } });
  await tools.saveServer({ name: 'others', previousName: null, enabled: true, providers: null, excludedProviders: ['kimi'], config: { type: 'stdio', command: 'others' } });
  const future = { ...paseo, providers: { snapshot: async () => ({ entries: [...entries, { provider: 'gemini', status: 'ready', enabled: true, label: 'Gemini' }] }) } } as unknown as Paseo;
  assert.deepEqual(await tools.mcpFor('gemini', undefined, future), { others: { type: 'stdio', command: 'others' } });
  assert.deepEqual(await readdir(join(home, '.gemini/skills')), ['denied']);
});

test('denying a skill keeps edited and independent copies and reports that they remain', async () => {
  await skill(tools.libraryDir, 'edited');
  await skill(tools.libraryDir, 'independent');
  await skill(join(home, '.claude/skills'), 'independent');
  await writeFile(join(home, '.claude/skills/independent/SKILL.md'), 'My independent skill');
  await tools.state(paseo);
  await writeFile(join(home, '.claude/skills/edited/SKILL.md'), 'My edited copy');
  let state = await tools.updateSkillAccess({ name: 'edited', providers: null, excludedProviders: ['claude'] });
  assert.match(state.notes.join('\n'), /edited after/);
  assert.equal(await readFile(join(home, '.claude/skills/edited/SKILL.md'), 'utf8'), 'My edited copy');
  state = await tools.updateSkillAccess({ name: 'independent', providers: [] });
  assert.match(state.notes.join('\n'), /independent skill or link/);
  assert.equal(await readFile(join(home, '.claude/skills/independent/SKILL.md'), 'utf8'), 'My independent skill');
});

test('a shared skills folder cannot bypass provider permissions', async () => {
  await skill(tools.libraryDir, 'restricted');
  await skill(tools.libraryDir, 'unrestricted');
  await tools.state(paseo);
  await tools.updateProvider({ provider: 'kimi', skillsDir: '~/.claude/skills' });
  let state = await tools.updateSkillAccess({ name: 'restricted', providers: ['claude'] });
  assert.match(state.notes.join('\n'), /same skills folder/);
  assert.equal(state.skills.find(s => s.name === 'restricted')!.targets[0]!.status, 'error');
  assert.deepEqual(await readdir(join(home, '.claude/skills')), ['unrestricted']);
  // Even an explicit overwrite request cannot distribute to a denied provider.
  await tools.overwriteSkill('restricted', 'claude');
  assert.deepEqual(await readdir(join(home, '.claude/skills')), ['unrestricted']);
  state = await tools.updateProvider({ provider: 'kimi', skillsDir: '' });
  assert.deepEqual(state.skills.find(s => s.name === 'restricted')!.targets.map(t => [t.provider, t.status]), [['claude', 'synced']]);
  assert.deepEqual(await readdir(join(home, '.kimi-code/skills')), ['unrestricted']);
});

test('malformed hand-edited policies never fall back to sharing with everyone', async () => {
  await skill(tools.libraryDir, 'restricted');
  await tools.state(paseo);
  const path = join(tools.root, 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.mcpServers = { docs: { command: 'docs', excludedProviders: 'kimi' } };
  config.skillAccess = { restricted: { providers: 'claude' } };
  await writeFile(path, JSON.stringify(config));
  const state = await tools.state(paseo);
  assert.deepEqual(state.mcpServers, []);
  assert.deepEqual(state.skills[0]!.providers, []);
  assert.match(state.notes.join('\n'), /invalid provider permissions/);
  assert.deepEqual(await readdir(join(home, '.claude/skills')), []);
  assert.equal(await tools.mcpFor('claude', undefined, paseo), null);
});

test('deleting a library skill clears its policy and unknown skill policy updates are rejected', async () => {
  await skill(tools.libraryDir, 'restricted');
  await tools.state(paseo);
  await tools.updateSkillAccess({ name: 'restricted', providers: [] });
  await tools.deleteSkill('restricted');
  const config = JSON.parse(await readFile(join(tools.root, 'config.json'), 'utf8'));
  assert.equal(config.skillAccess.restricted, undefined);
  await assert.rejects(tools.updateSkillAccess({ name: 'missing', providers: null }), /No library skill/);
});

test('reimporting MCP transport settings preserves local enablement and permissions', async () => {
  await tools.state(paseo);
  await tools.saveServer({ name: 'docs', previousName: null, enabled: false, providers: ['claude'], excludedProviders: ['kimi'], config: { type: 'stdio', command: 'old' } });
  const { state } = await tools.importServers('json', '{"docs":{"command":"new"}}', true);
  assert.deepEqual(state.mcpServers[0], {
    name: 'docs', enabled: false, providers: ['claude'], excludedProviders: ['kimi'], config: { type: 'stdio', command: 'new' },
  });
  assert.equal(await tools.mcpFor('claude', undefined, paseo), null);
  await tools.saveServer({ ...state.mcpServers[0]!, previousName: 'docs', enabled: true });
  assert.equal(await tools.mcpFor('kimi', undefined, paseo), null);
});

test('unavailable library skills keep their last synced copies', async () => {
  await skill(tools.libraryDir, 'tdd');
  await tools.state(paseo);
  await rm(join(tools.libraryDir, 'tdd/SKILL.md'));
  const state = await tools.syncNow();
  assert.match(state.notes.join('\n'), /library.*unavailable/i);
  assert.ok((await readdir(join(home, '.claude/skills'))).includes('tdd'));
});

test('rejects library overlap as a provider target, including symlink aliases', async () => {
  await skill(tools.libraryDir, 'tdd');
  await tools.state(paseo);
  const alias = join(home, 'library-alias');
  await symlink(tools.libraryDir, alias);
  for (const skillsDir of [tools.libraryDir, tools.root, join(tools.libraryDir, 'tdd'), alias, join(alias, 'new-target')]) {
    await assert.rejects(tools.updateProvider({ provider: 'claude', skillsDir }), /overlap.*library/i);
  }
  // A hand-edited path must also be refused before sync can adopt or remove library files.
  const path = join(tools.root, 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.providers.claude.skillsDir = alias;
  await writeFile(path, JSON.stringify(config));
  let state = await tools.syncNow();
  assert.match(state.notes.join('\n'), /overlap.*library/i);
  state = await tools.updateProvider({ provider: 'claude', skills: false });
  assert.ok((await readdir(join(tools.libraryDir, 'tdd'))).includes('SKILL.md'));
  assert.equal((await readdir(join(tools.libraryDir, 'tdd'))).includes('.paseo-shared-tools.json'), false);
});
