import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReconciledWorkspace, reconcileWorkspaceRows } from '../server/workspace-reconciliation.ts';
import { deduplicateCodexSessions } from '../server/codex-session-copies.ts';
import { emptyTokens, groupConsumption, sourceReportSchema, totalTokens, type ConsumptionRow, type WorkspaceConsumptionRow } from '../shared/consumption.ts';

const workspace = { id: 'a', label: '项目 A', directory: '/work/a' };
const row: ConsumptionRow = { ...emptyTokens(), date: '2026-09-16', model: 'gpt-test', inferredModel: false, input: 100, output: 20, cacheRead: 80, reasoning: 5 };
const attributed = (input: number): WorkspaceConsumptionRow => ({ ...row, input, workspace });
const signal = () => new AbortController().signal;

test('unchanged accounting needs one daily and one session read', async () => {
  let daily = 0, detail = 0;
  const result = await readReconciledWorkspace(async () => { daily++; return { rows: [row], message: null }; }, async () => { detail++; return { rows: [attributed(100)], message: null }; }, signal());
  assert.equal(result.message, null);
  assert.deepEqual([daily, detail], [1, 1]);
  assert.equal(result.workspaceRows[0].workspace?.id, workspace.id);
});

test('a call arriving between daily and sessions is attributed after rereading daily', async () => {
  let daily = 0, detail = 0;
  const result = await readReconciledWorkspace(async () => ({ rows: [{ ...row, input: ++daily === 1 ? 100 : 150 }], message: null }), async () => { detail++; return { rows: [attributed(150)], message: null }; }, signal());
  assert.deepEqual([daily, detail], [2, 1]);
  assert.equal(result.message, null);
  assert.equal(result.rows[0].input, 150);
  assert.equal(result.workspaceRows[0].workspace?.id, workspace.id);
  assert.equal(result.workspaceRows[0].input, 150);
});

test('a second call during the daily retry refreshes sessions once', async () => {
  let daily = 0, detail = 0;
  const result = await readReconciledWorkspace(async () => ({ rows: [{ ...row, input: ++daily === 1 ? 100 : 200 }], message: null }), async () => ({ rows: [attributed(++detail === 1 ? 150 : 200)], message: null }), signal());
  assert.deepEqual([daily, detail], [2, 2]);
  assert.equal(result.message, null);
  assert.equal(result.workspaceRows[0].workspace?.id, workspace.id);
  assert.equal(result.workspaceRows[0].input, 200);
});

test('continuous writes stop after bounded retries and preserve the latest daily buckets', async () => {
  let daily = 0, detail = 0;
  const result = await readReconciledWorkspace(async () => ({ rows: [{ ...row, input: ++daily * 100 }], message: null }), async () => ({ rows: [attributed(++detail * 100 + 50)], message: null }), signal());
  assert.deepEqual([daily, detail], [2, 2]);
  assert.ok(result.message);
  assert.equal(result.workspaceRows[0].workspace, undefined);
  assert.equal(result.workspaceRows[0].workspaceIssue, 'updating');
  assert.equal(result.workspaceRows[0].input, 200);
  assert.match(result.workspaceRows[0].workspaceNote!, /会话明细 270 token；每日合计 220 token/);
});

test('stable disagreement keeps good models and shows bucket-level diagnostics even when total tokens agree', async () => {
  const good = { ...row, model: 'good' };
  let daily = 0, detail = 0;
  const result = await readReconciledWorkspace(async () => { daily++; return { rows: [row, good], message: null }; }, async () => { detail++; return { rows: [{ ...attributed(100), cacheRead: 79 }, { ...good, workspace }], message: null }; }, signal());
  assert.deepEqual([daily, detail], [2, 1]);
  assert.equal(result.workspaceRows[0].workspaceIssue, 'accounting-mismatch');
  assert.match(result.workspaceRows[0].workspaceNote!, /缓存读取 79 \/ 80/);
  assert.equal(result.workspaceRows[1].workspace?.id, workspace.id);
  assert.equal(result.workspaceRows.reduce((sum, item) => sum + totalTokens(item), 0), 240);
  const nullable = reconcileWorkspaceRows([row], [{ ...attributed(100), reasoning: null }])[0];
  assert.match(nullable.workspaceNote!, /推理 未提供 \/ 5/);
});

test('only changing models receive the updating explanation', async () => {
  let daily = 0;
  const result = await readReconciledWorkspace(async () => ({ rows: [row, { ...row, model: 'active', input: ++daily * 100 }], message: null }), async () => ({ rows: [attributed(200), { ...attributed(500), model: 'active' }], message: null }), signal());
  assert.deepEqual(result.workspaceRows.map(row => row.workspaceIssue), ['accounting-mismatch', 'updating']);
});

test('unreadable detail and retry failures preserve daily totals without exposing error contents', async () => {
  const result = await readReconciledWorkspace(async () => ({ rows: [row], message: null }), async () => { throw new Error('private transcript'); }, signal());
  assert.equal(result.workspaceRows[0].workspaceIssue, 'read-error');
  assert.equal(totalTokens(result.workspaceRows[0]), 120);
  assert.ok(!JSON.stringify(result).includes('private transcript'));
  let daily = 0;
  const retried = await readReconciledWorkspace(async () => { if (++daily > 1) throw new Error('failed'); return { rows: [row], message: null }; }, async () => ({ rows: [attributed(200)], message: null }), signal());
  assert.equal(retried.workspaceRows[0].workspaceIssue, 'read-error');
  assert.equal(totalTokens(retried.workspaceRows[0]), 120);
  const controller = new AbortController();
  await assert.rejects(readReconciledWorkspace(async () => ({ rows: [row], message: null }), async () => { controller.abort(); throw new Error('aborted'); }, controller.signal), /取消/);
});

test('copied sessions require identical bytes, matching summaries and files unchanged since collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-copy-'));
  const paths = ['original', 'copy', 'different'].map(name => join(root, name));
  try {
    await Promise.all(paths.map((path, i) => writeFile(path, i === 2 ? 'different bytes' : 'same bytes')));
    const candidates = paths.map(path => ({ path, id: 'same-session', rows: [attributed(100)] }));
    const settled = Date.now() + 1000;
    assert.equal((await deduplicateCodexSessions(candidates, settled, signal())).length, 2);
    assert.equal((await deduplicateCodexSessions(candidates, 0, signal())).length, 3);
    assert.equal((await deduplicateCodexSessions([candidates[0], { ...candidates[1], rows: [attributed(200)] }], settled, signal())).length, 2);
    assert.equal((await deduplicateCodexSessions([candidates[0], { ...candidates[1], id: 'different-session' }], settled, signal())).length, 2);
    assert.equal((await deduplicateCodexSessions([candidates[0], { ...candidates[1], path: join(root, 'missing') }], settled, signal())).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unmatched, updating, mismatched and unreadable rows have separate categories with unchanged totals', () => {
  const source = sourceReportSchema.parse({ source: 'codex', status: 'partial', updatedAt: null, message: null, rows: [row], workspaceRows: [
    row, { ...row, workspaceIssue: 'updating' }, { ...row, workspaceIssue: 'accounting-mismatch', workspaceNote: '会话明细 130；每日合计 120' }, { ...row, workspaceIssue: 'read-error' }, { ...row, workspace },
  ] });
  const groups = groupConsumption([source], 'workspace');
  assert.deepEqual(groups.map(group => group.label), ['No Workspace assigned', 'Usage updating', 'Usage needs review', 'Assignment read failed', '项目 A']);
  assert.equal(new Set(groups.map(group => group.id)).size, 5);
  assert.ok(groups.slice(0, 4).every(group => group.note));
  assert.equal(groups[2].models[0].workspaceNote, '会话明细 130；每日合计 120');
  assert.equal(groups.reduce((sum, group) => sum + totalTokens(group), 0), 600);
  assert.equal(groupConsumption([source], 'model')[0].models[0].workspaceNote, undefined);
});
