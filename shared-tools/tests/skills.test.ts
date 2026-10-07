import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { describe, importSkillDir, MANIFEST, readLibrary, removeFromLibrary, syncTarget } from '../server/skills';

let root: string;
let library: string;
let backups: string;
let target: string;

async function skill(dir: string, name: string, body = 'Do the thing.', extra: Record<string, string> = {}) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} helper\n---\n${body}\n`);
  for (const [rel, text] of Object.entries(extra)) {
    await mkdir(join(dir, name, rel, '..'), { recursive: true });
    await writeFile(join(dir, name, rel), text);
  }
}

async function sync(force?: string[]) {
  const { skills } = await readLibrary(library);
  return syncTarget({ dir: target, providers: ['claude'], skills }, new Set(skills.map(s => s.name)), backups, new Set(force));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shared-tools-'));
  library = join(root, 'library');
  backups = join(root, 'backups');
  target = join(root, 'claude-skills');
});
afterEach(() => rm(root, { recursive: true, force: true }));

test('reads descriptions, including block values', () => {
  assert.equal(describe('---\nname: a\ndescription: "Quoted"\n---\n'), 'Quoted');
  assert.equal(describe('---\ndescription: >-\n  Folded\n  text\nother: 1\n---\n'), 'Folded text');
  assert.equal(describe('no front matter'), null);
});

test('copies library skills, then follows library edits and removals', async () => {
  await skill(library, 'tdd', 'v1', { 'refs/a.md': 'A' });
  let result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'synced');
  assert.match(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), /v1/);
  assert.equal(await readFile(join(target, 'tdd/refs/a.md'), 'utf8'), 'A');
  assert.ok((await readdir(join(target, 'tdd'))).includes(MANIFEST));

  await skill(library, 'tdd', 'v2');
  await rm(join(library, 'tdd/refs'), { recursive: true });
  result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'synced');
  assert.match(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), /v2/);
  assert.deepEqual((await readdir(join(target, 'tdd'))).sort(), [MANIFEST, 'SKILL.md']);

  await removeFromLibrary(library, 'tdd', backups);
  await sync();
  assert.deepEqual(await readdir(target), []);
  assert.equal((await readdir(backups)).length, 1);
});

test('never replaces a skill it did not write, and lists it for import', async () => {
  await skill(library, 'tdd', 'library');
  await skill(target, 'tdd', 'theirs');
  await skill(target, 'grill-me');
  const result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'conflict');
  assert.match(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), /theirs/);
  assert.deepEqual(result.found.map(f => [f.name, f.provider, f.description]), [['grill-me', 'claude', 'grill-me helper']]);
});

test('adopts an identical copy instead of reporting a conflict', async () => {
  await skill(library, 'tdd');
  await skill(target, 'tdd');
  const result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'synced');
  assert.ok((await readdir(join(target, 'tdd'))).includes(MANIFEST));
});

test('keeps a copy edited after syncing, until it is overwritten into the backups', async () => {
  await skill(library, 'tdd', 'library');
  await sync();
  await writeFile(join(target, 'tdd/SKILL.md'), 'local edit');
  let result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'modified');
  assert.equal(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), 'local edit');

  await removeFromLibrary(library, 'tdd', backups);
  result = await sync();
  assert.equal(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), 'local edit');
  assert.match(result.notes.join('\n'), /was kept/);

  await skill(library, 'tdd', 'library');
  result = await sync(['tdd']);
  assert.equal(result.placements.get('tdd')?.status, 'synced');
  assert.match(await readFile(join(target, 'tdd/SKILL.md'), 'utf8'), /library/);
  const saved = (await readdir(backups)).find(name => name.includes('claude-skills_tdd'));
  assert.ok(saved);
  assert.equal(await readFile(join(backups, saved, 'SKILL.md'), 'utf8'), 'local edit');
});

test('treats a link to the library as synced and any other link as a conflict', async () => {
  await skill(library, 'tdd');
  await skill(library, 'other');
  await mkdir(target, { recursive: true });
  await symlink(join(library, 'tdd'), join(target, 'tdd'));
  await skill(root, 'elsewhere');
  await symlink(join(root, 'elsewhere'), join(target, 'other'));
  const result = await sync();
  assert.equal(result.placements.get('tdd')?.status, 'synced');
  assert.equal(result.placements.get('other')?.status, 'conflict');
});

test('imports a provider skill without its manifest, and refuses duplicates', async () => {
  await skill(target, 'grill-me', 'body', { 'notes.md': 'n' });
  await writeFile(join(target, 'grill-me', MANIFEST), '{}');
  await mkdir(library, { recursive: true });
  assert.equal(await importSkillDir(join(target, 'grill-me'), library, false, backups), 'grill-me');
  assert.deepEqual((await readdir(join(library, 'grill-me'))).sort(), ['SKILL.md', 'notes.md']);
  await assert.rejects(importSkillDir(join(target, 'grill-me'), library, false, backups), /already has/);
  await assert.rejects(importSkillDir(join(library, 'grill-me'), library, true, backups), /already in the library/);
  await mkdir(join(root, 'no-skill'));
  await assert.rejects(importSkillDir(join(root, 'no-skill'), library, false, backups), /no SKILL.md/);
});

test('leaves a missing folder alone when there is nothing to put in it', async () => {
  const result = await sync();
  assert.equal(result.placements.size, 0);
  await assert.rejects(readdir(target));
});
