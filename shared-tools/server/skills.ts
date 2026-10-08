import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { nameSchema, type FoundSkill, type TargetStatus } from '../shared/rpc';

/** Written into every copy the plugin makes; a folder without it belongs to someone else. */
export const MANIFEST = '.paseo-shared-tools.json';
const SKILL_FILE = 'SKILL.md';
const MAX_DEPTH = 12;
const MAX_FILES = 5000;

/** Relative POSIX path → sha256 of the file's bytes. */
type Files = Map<string, string>;

export interface LibrarySkill { name: string; dir: string; description: string | null; files: Files }
export interface Target { dir: string; providers: string[]; skills: readonly LibrarySkill[] }
export interface Placement { status: TargetStatus; message: string | null }
export interface TargetReport { placements: Map<string, Placement>; found: FoundSkill[]; notes: string[] }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hashes a skill folder, following links the way the CLIs reading it do, and skipping the manifest. */
async function hashTree(root: string): Promise<Files> {
  const files: Files = new Map();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error(`${root} is nested more than ${MAX_DEPTH} folders deep.`);
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (rel === MANIFEST) continue;
      const info = await stat(full).catch(() => null);
      if (info?.isDirectory()) await walk(full, depth + 1);
      else if (info?.isFile()) {
        if (files.size >= MAX_FILES) throw new Error(`${root} has more than ${MAX_FILES} files.`);
        files.set(rel, createHash('sha256').update(await readFile(full)).digest('hex'));
      }
    }
  };
  await walk(root, 0);
  return files;
}

function same(a: Files, b: Files): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, sha] of a) if (b.get(rel) !== sha) return false;
  return true;
}

async function readManifest(dir: string): Promise<Files | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as { version?: unknown; files?: unknown };
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object') return null;
    return new Map(Object.entries(parsed.files as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return null;
  }
}

function manifestText(files: Files): string {
  return `${JSON.stringify({ version: 1, note: 'Managed by the paseo-shared-tools plugin. Edit the copy in its library instead.', files: Object.fromEntries(files) }, null, 2)}\n`;
}

/** The `description` from SKILL.md's front matter, including folded and literal block values. */
export function describe(text: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!front) return null;
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex(line => /^description\s*:/.test(line));
  if (at < 0) return null;
  let value = lines[at]!.replace(/^description\s*:\s*/, '').trim();
  if (/^[|>][-+]?$/.test(value) || value === '') {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = block.filter(Boolean).join(' ');
  }
  value = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  return value || null;
}

async function isSkillDir(dir: string): Promise<boolean> {
  return (await stat(join(dir, SKILL_FILE)).catch(() => null))?.isFile() ?? false;
}

async function readDescription(dir: string): Promise<string | null> {
  return describe(await readFile(join(dir, SKILL_FILE), 'utf8').catch(() => ''));
}

/** Every folder in the library with a SKILL.md and a name every CLI accepts. */
export async function readLibrary(libraryDir: string): Promise<{ skills: LibrarySkill[]; notes: string[] }> {
  await mkdir(libraryDir, { recursive: true });
  const skills: LibrarySkill[] = [];
  const notes: string[] = [];
  for (const name of (await readdir(libraryDir)).sort()) {
    if (name.startsWith('.')) continue;
    const dir = join(libraryDir, name);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
    if (!nameSchema.safeParse(name).success) { notes.push(`Library folder "${name}" was skipped: use letters, digits, "_" and "-" only.`); continue; }
    if (!(await isSkillDir(dir))) { notes.push(`Library folder "${name}" was skipped: it has no ${SKILL_FILE}.`); continue; }
    try { skills.push({ name, dir, description: await readDescription(dir), files: await hashTree(dir) }); }
    catch (error) { notes.push(`Library skill "${name}" was skipped: ${message(error)}`); }
  }
  return { skills, notes };
}

async function moveAside(from: string, backupDir: string, label: string): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const to = join(backupDir, `${label}-${stamp}-${randomBytes(2).toString('hex')}`);
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
  return to;
}

/** Copies through a temporary folder, so a CLI scanning mid-sync never sees half a skill. */
async function writeCopy(skill: LibrarySkill, path: string, dir: string): Promise<void> {
  const temporary = join(dir, `.${skill.name}.paseo-tmp-${randomBytes(4).toString('hex')}`);
  try {
    await cp(skill.dir, temporary, { recursive: true, dereference: true, filter: source => basename(source) !== MANIFEST });
    await writeFile(join(temporary, MANIFEST), manifestText(skill.files));
    await rm(path, { recursive: true, force: true });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function backupLabel(dir: string, name: string): string {
  return `${dir.replace(/^[/\\]+/, '').replace(/[/\\:]+/g, '_')}_${name}`;
}

async function place(skill: LibrarySkill, dir: string, force: boolean, backupDir: string): Promise<Placement> {
  const path = join(dir, skill.name);
  const info = await lstat(path).catch(() => null);
  const replace = async (reason: string): Promise<Placement> => {
    if (!force) return { status: reason === 'edited' ? 'modified' : 'conflict', message: reason === 'edited' ? 'Edited here since the last sync.' : reason };
    const saved = await moveAside(path, backupDir, backupLabel(dir, skill.name));
    await writeCopy(skill, path, dir);
    return { status: 'synced', message: `The previous copy was moved to ${saved}.` };
  };
  if (!info) {
    await writeCopy(skill, path, dir);
    return { status: 'synced', message: null };
  }
  if (info.isSymbolicLink()) {
    const target = await realpath(path).catch(() => null);
    if (target && target === await realpath(skill.dir).catch(() => null)) return { status: 'synced', message: 'Linked to the library.' };
    return replace(`A link to ${target ?? 'a missing folder'} is already here.`);
  }
  if (!info.isDirectory()) return replace('A file with this name is already here.');
  const manifest = await readManifest(path);
  const current = await hashTree(path);
  if (manifest) {
    if (!same(current, manifest)) return replace('edited');
    if (!same(current, skill.files)) await writeCopy(skill, path, dir);
    return { status: 'synced', message: null };
  }
  if (same(current, skill.files)) {
    // Someone's own copy that matches the library exactly: from now on it follows the library.
    await writeFile(join(path, MANIFEST), manifestText(skill.files));
    return { status: 'synced', message: null };
  }
  return replace('A different skill with this name is already here.');
}

/**
 * Brings one skills folder in line with the library: adds and updates the plugin's copies,
 * removes copies of skills that left the library, and lists other skills found there.
 * Anything the plugin did not write, or that was edited after it wrote it, is left alone
 * unless its name is in `force`, in which case it is moved to `backupDir` first.
 */
export async function syncTarget(target: Target, librarySkillNames: ReadonlySet<string>, backupDir: string, force: ReadonlySet<string> = new Set()): Promise<TargetReport> {
  const placements = new Map<string, Placement>();
  const found: FoundSkill[] = [];
  const notes: string[] = [];
  const existing = await readdir(target.dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null && target.skills.length === 0) return { placements, found, notes };
  if (existing === null) await mkdir(target.dir, { recursive: true });

  const wanted = new Set(target.skills.map(skill => skill.name));
  for (const skill of target.skills) {
    try { placements.set(skill.name, await place(skill, target.dir, force.has(skill.name), backupDir)); }
    catch (error) { placements.set(skill.name, { status: 'error', message: message(error) }); }
  }

  for (const name of (existing ?? []).sort()) {
    // Left behind when the daemon stopped in the middle of a copy.
    if (/^\..+\.paseo-tmp-[0-9a-f]{8}$/.test(name)) { await rm(join(target.dir, name), { recursive: true, force: true }); continue; }
    if (name.startsWith('.') || wanted.has(name)) continue;
    const path = join(target.dir, name);
    const info = await lstat(path).catch(() => null);
    const manifest = info?.isDirectory() ? await readManifest(path) : null;
    if (manifest) {
      try {
        if (same(await hashTree(path), manifest)) await rm(path, { recursive: true, force: true });
        else notes.push(`${path} was kept: it was edited after the plugin copied it there.`);
      } catch (error) { notes.push(`${path} could not be removed: ${message(error)}`); }
      continue;
    }
    if (librarySkillNames.has(name) && await isSkillDir(path)) {
      notes.push(`${path} was kept: it is an independent skill or link, so shared provider permissions cannot remove it.`);
    } else if (await isSkillDir(path)) {
      for (const provider of target.providers) found.push({ name, provider, path, description: await readDescription(path) });
    }
  }
  return { placements, found, notes };
}

/** Adds a skill folder to the library under its own folder name. */
export async function importSkillDir(source: string, libraryDir: string, replace: boolean, backupDir: string): Promise<string> {
  const from = resolve(source);
  if (!(await stat(from).catch(() => null))?.isDirectory()) throw new Error(`${from} is not a folder.`);
  if (!(await isSkillDir(from))) throw new Error(`${from} has no ${SKILL_FILE}.`);
  const name = nameSchema.safeParse(basename(from));
  if (!name.success) throw new Error(`"${basename(from)}" is not a usable skill name: use letters, digits, "_" and "-" only.`);
  const library = await realpath(libraryDir);
  const real = await realpath(from);
  if (real === library || real.startsWith(library + sep)) throw new Error('That folder is already in the library.');
  const dest = join(libraryDir, name.data);
  const exists = await lstat(dest).catch(() => null);
  if (exists && !replace) throw new Error(`The library already has a skill named "${name.data}".`);
  const temporary = join(libraryDir, `.${name.data}.paseo-tmp-${randomBytes(4).toString('hex')}`);
  try {
    await cp(from, temporary, { recursive: true, dereference: true, filter: path => basename(path) !== MANIFEST });
    if (exists) await moveAside(dest, backupDir, `library_${name.data}`);
    await rename(temporary, dest);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return name.data;
}

/** Moves a library skill to the backup folder; the next sync removes its untouched copies. */
export async function removeFromLibrary(libraryDir: string, name: string, backupDir: string): Promise<void> {
  const valid = nameSchema.parse(name);
  const path = join(libraryDir, valid);
  if (!(await lstat(path).catch(() => null))) throw new Error(`The library has no skill named "${valid}".`);
  await moveAside(path, backupDir, `library_${valid}`);
}
