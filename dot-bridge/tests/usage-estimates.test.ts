import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendDotMessage, createTask } from '../shared/machine';
import { emptyVerification, resultSchema } from '../shared/schema';
import { BridgeStore } from '../server/store';
import { buildUsageEstimateLedger, estimateVisibleText } from '../server/usage-estimates';

const dirs: string[] = [];
after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dot-usage-'));
  dirs.push(dir);
  return dir;
}
function sampleTask() {
  const task = createTask({
    id: randomUUID(), connectionId: 'a'.repeat(32), workspaceId: 'workspace-1',
    mode: 'text', repository: null, remoteName: null, branch: null,
    environmentHint: 'Not visible input', title: 'Not counted again',
    requirement: 'abcd中文', acceptance: '', baseSha: null, targetBranch: null,
    roundId: randomUUID(), at: 1000,
  });
  task.workspaceRoot = '/workspace/project';
  return task;
}
function result(updateId: string, summary: string, reportedAt = 2000) {
  return resultSchema.parse({ kind: 'text', updateId, summary, reportedAt, processedThroughSeq: 1 });
}
async function readLedger(dir: string) {
  return JSON.parse(await readFile(join(dir, 'usage-estimates.json'), 'utf8')) as ReturnType<typeof buildUsageEstimateLedger>;
}

describe('visible-text-v1 estimates', () => {
  it('counts ASCII quarters and non-ASCII code points with a single ceiling', () => {
    assert.equal(estimateVisibleText(''), 0);
    assert.equal(estimateVisibleText('a'), 1);
    assert.equal(estimateVisibleText('abcde'), 2);
    assert.equal(estimateVisibleText('中文'), 2);
    assert.equal(estimateVisibleText('abcd中文'), 3);
    assert.equal(estimateVisibleText('a😀'), 2);
    assert.equal(estimateVisibleText('😀'), 1);
  });

  it('counts each new user message once, never duplicated requirement/context metadata', () => {
    const task = sampleTask();
    task.messages.push({ ...task.messages[0]!, seq: 2, body: 'efgh', at: 3000 });
    // Acknowledgement IDs may be shared across different user messages.
    for (const message of task.messages) message.updateId = 'ack';
    const ledger = buildUsageEstimateLedger([task]);
    assert.equal(ledger.version, 1);
    assert.equal(ledger.algorithm, 'visible-text-v1');
    assert.deepEqual(ledger.entries.map(entry => entry.input), [3, 1]);
    assert.ok(ledger.entries.every(entry => entry.cwd === task.workspaceRoot));
    assert.equal(JSON.stringify(ledger).includes('abcd中文'), false);
    assert.deepEqual(buildUsageEstimateLedger([task]), ledger);
  });

  it('deduplicates progress replays, result snapshots and message/result mirrors by stable ID', () => {
    let task = sampleTask();
    task = appendDotMessage(task, task.currentRoundId, 'progress', 'abcd', 1200, 'progress-1');
    task = appendDotMessage(task, task.currentRoundId, 'progress', 'abcdefgh', 1300, 'progress-1');
    task = appendDotMessage(task, task.currentRoundId, 'question', '中文', 1400, 'question-1');
    task = appendDotMessage(task, task.currentRoundId, 'result', 'old mirror', 1500, 'result-1');
    const round = task.rounds[0]!;
    round.progressHistory = [{ updateId: 'progress-1', kind: 'running', note: 'abcdefgh', at: 1300, processedThroughSeq: 1 }];
    round.resultHistory = [
      { result: result('result-1', 'old'), verification: emptyVerification() },
      { result: result('result-1', 'old'), verification: emptyVerification() },
      { result: result('result-2', 'distinct', 1900), verification: emptyVerification() },
    ];
    round.result = result('result-1', '中文中文');
    const ledger = buildUsageEstimateLedger([task]);
    assert.equal(ledger.entries.length, 5);
    assert.equal(ledger.entries.reduce((sum, entry) => sum + entry.output, 0), 10);
    assert.equal(ledger.entries.find(entry => entry.id.includes('result-1'))?.output, 4);
    round.result = result('result-1', '中');
    assert.equal(buildUsageEstimateLedger([task]).entries.find(entry => entry.id.includes('result-1'))?.output, 1);
  });

  it('excludes tool receipts and notes, keeps distinct tasks and provider cwd', () => {
    let task = sampleTask();
    const operationId = randomUUID();
    task.localChanges.push({ operationId, roundId: task.currentRoundId, status: 'applied', files: [], conflicts: [], at: 1100 });
    task = appendDotMessage(task, task.currentRoundId, 'progress', 'generated tool receipt', 1100, operationId);
    task = appendDotMessage(task, task.currentRoundId, 'note', 'attachment metadata', 1200, 'attachment');
    task.provider = { cwd: '/provider/project', clientMessageIds: {} };
    const other = { ...structuredClone(task), id: randomUUID() };
    const ledger = buildUsageEstimateLedger([task, other]);
    assert.equal(ledger.entries.length, 2);
    assert.ok(ledger.entries.every(entry => entry.output === 0 && entry.cwd === '/provider/project'));
  });
});

describe('durable usage snapshot', () => {
  it('creates empty snapshots and replaces them on mutations; repairs missing/stale snapshots on reopen', async () => {
    const dir = await tempDir();
    let store = await BridgeStore.open(dir);
    assert.deepEqual((await readLedger(dir)).entries, []);
    const task = sampleTask();
    await store.mutate(draft => { draft.tasks.push(task); });
    assert.deepEqual(await readLedger(dir), buildUsageEstimateLedger([task]));
    await store.mutate(draft => { draft.tasks[0]!.messages[0]!.body = 'abcd'; });
    assert.equal((await readLedger(dir)).entries[0]!.input, 1);
    await store.dispose();
    await writeFile(join(dir, 'usage-estimates.json'), '{"obsolete":true}');
    store = await BridgeStore.open(dir);
    assert.equal((await readLedger(dir)).entries[0]!.input, 1);
    assert.equal((await stat(join(dir, 'usage-estimates.json'))).mode & 0o777, 0o600);
    await store.dispose();
    await rm(join(dir, 'usage-estimates.json'));
    store = await BridgeStore.open(dir);
    assert.equal((await readLedger(dir)).entries[0]!.input, 1);
    await store.dispose();
  });

  it('does not export an uncommitted mutation when the authoritative state write fails', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir, { write: async () => { throw new Error('state failed'); } });
    await assert.rejects(store.mutate(draft => { draft.tasks.push(sampleTask()); }), /state failed/);
    assert.deepEqual((await readLedger(dir)).entries, []);
    assert.deepEqual(store.read().tasks, []);
    await store.dispose();
  });

  it('invalidates a failed snapshot without falsely rejecting committed state, then repairs at open', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'usage-estimates.json'), '{"obsolete":true}');
    const store = await BridgeStore.open(dir, { writeUsageEstimates: async () => { throw new Error('snapshot failed'); } });
    assert.equal(store.loadError, null);
    const task = sampleTask();
    await store.mutate(draft => { draft.tasks.push(task); });
    assert.equal(store.read().tasks.length, 1);
    assert.match(store.usageEstimateError!, /snapshot failed/);
    await assert.rejects(readLedger(dir), { code: 'ENOENT' });
    await store.dispose();
    const reopened = await BridgeStore.open(dir);
    assert.equal(reopened.usageEstimateError, null);
    assert.deepEqual(await readLedger(dir), buildUsageEstimateLedger([task]));
    await reopened.dispose();
  });

  it('a second locked store cannot replace the active store snapshot', async () => {
    const dir = await tempDir();
    const store = await BridgeStore.open(dir);
    await store.mutate(draft => { draft.tasks.push(sampleTask()); });
    const before = await readLedger(dir);
    const locked = await BridgeStore.open(dir);
    assert.equal(locked.loadError, 'store-locked');
    assert.deepEqual(await readLedger(dir), before);
    await locked.dispose();
    await store.dispose();
  });
});
