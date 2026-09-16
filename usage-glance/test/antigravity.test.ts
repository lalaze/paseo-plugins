import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generationMetadata, stepMetadata, dedupeAgy, type AgyEvent } from '../server/antigravity-proto.ts';
import { runAntigravity } from '../server/antigravity.ts';

// Minimal protobuf fixtures, containing accounting fields only.
function varint(input: number): Buffer { let value = BigInt(input); const bytes = []; do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); }
const num = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const buf = (field: number, value: Buffer | string) => { const data = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]); };
const seconds = Date.parse('2026-09-10T16:30:00Z') / 1000;
const timestamp = num(1, seconds);
const usage = (id: string, input = 100) => Buffer.concat([num(1, 1318), num(2, input), num(3, 30), num(4, 20), num(5, 70), num(9, 10), num(10, 20), buf(11, id)]);
const generation = (id: string, retries = false) => buf(1, Buffer.concat([buf(19, 'gemini-3.8-flash'), buf(4, usage(id)), buf(9, buf(4, timestamp)), ...(retries ? [buf(17, buf(2, usage('retry', 50)))] : [])]));
const step = (id: string) => Buffer.concat([buf(9, usage(id)), buf(8, timestamp), buf(24, buf(12, 'gemini-3.8-flash'))]);
const range = { since: '2026-09-01', until: '2026-09-15', timezone: 'UTC' };

test('Antigravity reads token buckets, retries, real timestamps and preserves current model labels', () => {
  const parsed = generationMetadata(generation('first', true));
  assert.equal(parsed.model, 'gemini-3.8-flash');
  assert.equal(parsed.time, seconds * 1000);
  assert.equal(parsed.usages.length, 2);
  assert.equal(parsed.usages[0].fresh, 100); // Field 1 is a model ID, not input.
  assert.equal(parsed.usages[0].output, 30); // Includes reasoning, not 40.
  assert.equal(parsed.usages[0].cacheRead, 70);
  assert.equal(stepMetadata(step('first')).time, parsed.time);
  assert.throws(() => generationMetadata(Buffer.from([10, 127, 1])));
  assert.throws(() => generationMetadata(Buffer.from([0])));
});

test('identity bridges collapse generation, retry, step, and backup copies without double counting', () => {
  const make = (identities: string[], timeRank: number, time?: number): AgyEvent => ({ fresh: 100, cacheRead: 70, cacheWrite: 20, output: 30, reasoning: 10, model: 'gemini-3.8-flash', identities, timeRank, time });
  const result = dedupeAgy([make(['response:one'], 0), make(['message:one'], 1, 100), make(['response:one', 'message:one'], 2, 200), make(['response:two'], 2, 300)]);
  assert.equal(result.length, 2); assert.equal(result[0].time, 200); assert.equal(result[0].fresh, 100);
  const conflict = dedupeAgy([{ ...make(['response:shared'], 2, 200), workspace: { id: 'one', label: 'One', directory: '/one' } }, { ...make(['response:shared'], 2, 200), workspace: { id: 'two', label: 'Two', directory: '/two' } }]);
  assert.equal(conflict.length, 1); assert.equal(conflict[0].workspace, undefined);
});

test('real SQLite reads deduplicate backups, include retry usage, and obey timezone and date boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-agy-tokens-'));
  try {
    const directory = join(root, 'one', 'conversations'), backup = join(root, 'backup', 'conversations');
    await mkdir(directory, { recursive: true }); await mkdir(backup, { recursive: true });
    const path = join(directory, 'session.db'), db = new DatabaseSync(path);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, metadata BLOB);');
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(1, generation('first', true));
    db.prepare('INSERT INTO steps VALUES (?,?)').run(1, step('first')); db.close();
    await copyFile(path, join(backup, 'session.db'));
    const run = (input = range) => runAntigravity(input, new AbortController().signal, [join(root, 'one'), join(root, 'backup')]);
    const first = await run(); assert.equal(first.rows.length, 1); assert.equal(first.message, null);
    assert.equal(first.rows[0].model, 'gemini-3.8-flash');
    assert.equal(first.rows[0].input, 330); assert.equal(first.rows[0].output, 60);
    assert.deepEqual(await run(), first);
    const workspace = { id: 'workspace', label: 'Workspace', directory: '/project' };
    const attributed = await runAntigravity(range, new AbortController().signal, [join(root, 'one'), join(root, 'backup')], id => id === 'session' ? workspace : undefined);
    assert.deepEqual(attributed.rows, first.rows.map(row => ({ ...row, workspace })));
    assert.equal((await run({ ...range, timezone: 'Asia/Shanghai' })).rows[0].date, '2026-09-11');
    assert.deepEqual((await run({ ...range, until: '2026-09-09' })).rows, []);
    await writeFile(join(directory, 'bad.db'), 'invalid database');
    const partial = await run(); assert.equal(partial.rows[0].input, 330); assert.match(partial.message!, /未能读取/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
