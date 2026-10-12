import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { localChangesSchema, localPathSchema, localReceiptSchema, MAX_CHANGE_BYTES, MAX_SOURCE_BYTES, type LocalChange, type LocalReceipt } from '../shared/local-files';

const blocked = new Set(['.git', '.paseo', '.codex', '.agents', '.aws', '.ssh', '.gnupg', '.config', '.npmrc', '.netrc', '.pypirc', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519']);
const hiddenFromListing = new Set(['node_modules', '.venv', '.cache']);
export const sourceHash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function fail(message: string): never { throw new Error(`Local files: ${message}`); }

export function validateLocalPath(path: string, allowRoot = false): string[] {
  if (allowRoot && path === '') return [];
  if (!path || path.length > 1000 || /[\\\x00-\x1f\x7f:]/.test(path)) fail('invalid relative path');
  const parts = path.split('/');
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!part || part === '.' || part === '..' || part !== part.trim()) fail('use a normalized relative path');
    if (blocked.has(lower) || lower === '.env' || lower.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(part) || lower.includes('.dot-tmp-')) fail(`protected path: ${path}`);
  }
  return parts;
}

/** Canonical root is server-bound. Never follow a symlink below it, even if it points inside. */
function target(root: string, path: string, allowRoot = false): string {
  const parts = validateLocalPath(path, allowRoot);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail('workspace root changed');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail(`symlink refused: ${path}`);
      if (index < parts.length - 1 && !stat.isDirectory()) fail(`parent is not a directory: ${path}`);
    } catch (error) { if (!missing(error)) throw error; }
  }
  return current;
}

export function canonicalWorkspace(path: string): string {
  const root = realpathSync(resolve(path));
  if (!lstatSync(root).isDirectory() || root === '/') fail('invalid workspace directory');
  return root;
}

export function readSource(root: string, path: string): { path: string; content: string | null; sha256: string | null; mode: number | null } {
  const file = target(root, path);
  let fd: number;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.nlink !== 1) fail(`only ordinary, non-hardlinked files are supported: ${path}`);
    // NONBLOCK prevents a replaced FIFO/device from hanging the daemon before fstat can reject it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) { if (missing(error)) return { path, content: null, sha256: null, mode: null }; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail(`only ordinary, non-hardlinked files are supported: ${path}`);
    if (stat.size > MAX_SOURCE_BYTES) fail(`file exceeds 256 KiB: ${path}`);
    // Bounded fd read also catches a file that grows after stat.
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size > MAX_SOURCE_BYTES) fail(`file exceeds 256 KiB: ${path}`);
    const body = bytes.subarray(0, size);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { fail(`file is not UTF-8: ${path}`); }
    if (content.includes('\0')) fail(`binary file refused: ${path}`);
    return { path, content, sha256: sourceHash(body), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export function listSources(root: string, directory = '', offset = 0) {
  const dir = target(root, directory, true);
  if (!lstatSync(dir).isDirectory()) fail('not a directory');
  const entries = readdirSync(dir, { withFileTypes: true }).filter(entry => {
    if (entry.isSymbolicLink() || hiddenFromListing.has(entry.name)) return false;
    try { validateLocalPath([directory, entry.name].filter(Boolean).join('/')); return entry.isFile() || entry.isDirectory(); } catch { return false; }
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { directory, entries: entries.slice(offset, offset + 200).map(entry => ({ path: [directory, entry.name].filter(Boolean).join('/'), type: entry.isDirectory() ? 'directory' : 'file' })), nextOffset: offset + 200 < entries.length ? offset + 200 : null };
}

type Snapshot = ReturnType<typeof readSource>;
type Journal = { hash: string; root: string; changes: LocalChange[]; before: Snapshot[]; receipt: LocalReceipt; finished: boolean; intent: number | null };
function persist(path: string, journal: Journal) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

const displayJournalSchema = z.object({
  changes: localChangesSchema,
  before: z.array(z.object({ path: localPathSchema, content: z.string().max(MAX_SOURCE_BYTES).nullable() })).max(32),
});

/** Original and requested contents of one operation, for display. Invalid journals omit the diff. */
export function readChangeJournal(dataDir: string, operationId: string): { changes: LocalChange[]; before: Array<{ path: string; content: string | null }> } | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) return null;
  try {
    return displayJournalSchema.parse(JSON.parse(readFileSync(join(dataDir, 'local-changes', `${operationId}.json`), 'utf8')));
  } catch { return null; }
}

/** A durable journal makes lost responses safe to replay, without reapplying after later edits.
 * All preconditions are checked before the first write; unexpected later conflicts report the
 * exact applied subset. A crashed partial operation is inspected, never blindly resumed.
 */
export function applyLocalChanges(input: { dataDir: string; root: string; taskId: string; roundId: string; operationId: string; userMessageSeq: number; changes: LocalChange[]; at: number }): LocalReceipt {
  const receipt: LocalReceipt = localReceiptSchema.parse({ operationId: input.operationId, roundId: input.roundId, status: 'applied', files: [], conflicts: [], at: input.at });
  const changes = localChangesSchema.parse(input.changes);
  if (changes.reduce((n, change) => n + Buffer.byteLength(change.content ?? ''), 0) > MAX_CHANGE_BYTES) fail('change set exceeds 1 MiB');
  const pathKeys = changes.map(change => { validateLocalPath(change.path); return change.path.normalize('NFC').toLowerCase(); });
  if (new Set(pathKeys).size !== pathKeys.length) fail('duplicate or case-ambiguous paths');
  if (pathKeys.some(path => pathKeys.some(other => other !== path && other.startsWith(`${path}/`)))) fail('overlapping file paths');
  for (const change of changes) {
    if (change.content !== null && (Buffer.byteLength(change.content) > MAX_SOURCE_BYTES || change.content.includes('\0') || Buffer.from(change.content).toString('utf8') !== change.content)) fail(`invalid UTF-8 text or oversized file: ${change.path}`);
    if (change.content === null && change.expectedSha256 === null) fail('deletion requires an existing file hash');
  }
  const hash = sourceHash(JSON.stringify({ root: input.root, taskId: input.taskId, roundId: input.roundId, userMessageSeq: input.userMessageSeq, changes }));
  const directory = join(input.dataDir, 'local-changes'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journalPath = join(directory, `${input.operationId}.json`);
  let previous: Journal | null = null;
  try { previous = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal; } catch (error) { if (!missing(error)) throw error; }
  if (previous) {
    if (previous.hash !== hash || previous.root !== input.root) fail('operationId was already used with different content');
    const receipt = localReceiptSchema.parse(previous.receipt);
    if (previous.finished) return receipt;
    // An interrupted rename/unlink may have succeeded before its receipt was saved.
    if (previous.intent !== null) {
      const change = changes[previous.intent]!;
      const afterHash = change.content === null ? null : sourceHash(change.content);
      try {
        if (readSource(input.root, change.path).sha256 === afterHash && !receipt.files.some(file => file.path === change.path)) receipt.files.push({ path: change.path, action: change.content === null ? 'delete' : change.expectedSha256 === null ? 'create' : 'update', beforeSha256: change.expectedSha256, afterSha256: afterHash });
      } catch { /* Uncertain state remains a visible conflict. */ }
    }
    receipt.status = receipt.files.length ? 'partial' : 'conflict';
    receipt.conflicts = ['Interrupted file operation: inspect current files and submit a new operation; no further writes were made.'];
    persist(journalPath, { ...previous, receipt, finished: true });
    return receipt;
  }
  const before = changes.map(change => readSource(input.root, change.path));
  changes.forEach((change, index) => { if (before[index]!.sha256 !== change.expectedSha256) receipt.conflicts.push(`File changed since read: ${change.path}`); });
  const journal: Journal = { hash, root: input.root, changes, before, receipt, finished: false, intent: null };
  if (receipt.conflicts.length) { receipt.status = 'conflict'; journal.finished = true; persist(journalPath, journal); return receipt; }
  persist(journalPath, journal);
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    let temp: string | null = null;
    try {
      // Re-check immediately before each mutation; no asynchronous work intervenes.
      if (readSource(input.root, change.path).sha256 !== change.expectedSha256) fail(`file changed since read: ${change.path}`);
      let file = target(input.root, change.path);
      if (change.content !== null) {
        mkdirSync(dirname(file), { recursive: true });
        file = target(input.root, change.path);
        temp = join(dirname(file), `.${file.split('/').at(-1)}.dot-tmp-${randomUUID()}`);
        const fd = openSync(temp, 'wx', before[index]!.mode ?? 0o644);
        try { writeFileSync(fd, change.content); if (before[index]!.mode !== null) fchmodSync(fd, before[index]!.mode!); fsyncSync(fd); } finally { closeSync(fd); }
      }
      journal.intent = index; persist(journalPath, journal);
      if (readSource(input.root, change.path).sha256 !== change.expectedSha256) fail(`file changed before write: ${change.path}`);
      target(input.root, change.path);
      if (change.content === null) unlinkSync(file);
      else if (change.expectedSha256 === null) { linkSync(temp!, file); unlinkSync(temp!); temp = null; }
      else { renameSync(temp!, file); temp = null; }
      const parent = openSync(dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
      receipt.files.push({ path: change.path, action: change.content === null ? 'delete' : change.expectedSha256 === null ? 'create' : 'update', beforeSha256: change.expectedSha256, afterSha256: change.content === null ? null : sourceHash(change.content) });
      journal.intent = null; persist(journalPath, journal);
    } catch (error) {
      if (temp) { try { unlinkSync(temp); } catch { /* Keep original failure. */ } }
      if (journal.intent === index && !receipt.files.some(file => file.path === change.path)) {
        const afterSha256 = change.content === null ? null : sourceHash(change.content);
        try { if (readSource(input.root, change.path).sha256 === afterSha256) receipt.files.push({ path: change.path, action: change.content === null ? 'delete' : change.expectedSha256 === null ? 'create' : 'update', beforeSha256: change.expectedSha256, afterSha256 }); } catch { /* Preserve the explicit failure. */ }
      }
      receipt.status = receipt.files.length ? 'partial' : 'conflict';
      receipt.conflicts.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  journal.finished = true; persist(journalPath, journal);
  return receipt;
}
