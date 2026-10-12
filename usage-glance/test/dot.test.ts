import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDotUsage, dotUsageFile } from '../server/dot';
import { enabledConsumptionSources, unsupportedConsumptionProviders, totalTokens, groupConsumption } from '../shared/consumption';
import { buildMonthHeatmap } from '../shared/heatmap';

const range = { since: '2026-10-12', until: '2026-10-12', timezone: 'UTC' };
const row = { id: 'm1', at: Date.parse('2026-10-12T00:30:00Z'), taskId: 'task', workspaceId: 'work', cwd: '/project', input: 10, output: 0 };
const ledger = (entries: unknown[]) => ({ version: 1, algorithm: 'visible-text-v1', entries });
test('dot estimates follow provider switch and are not unsupported', () => {
  assert.deepEqual(enabledConsumptionSources([{ provider: 'dot', enabled: true }]), ['dot']);
  assert.deepEqual(enabledConsumptionSources([{ provider: 'dot', enabled: false }]), []);
  assert.deepEqual(unsupportedConsumptionProviders([{ provider: 'dot', enabled: true }]), []);
});
test('stable IDs replace duplicate records; date filtering uses client timezone', () => {
  const data = ledger([row, { ...row, input: 20 }, { ...row, id: 'm2', input: 0, output: 5 }]);
  assert.equal(parseDotUsage(data, range).reduce((sum, r) => sum + totalTokens(r), 0), 25);
  assert.equal(parseDotUsage(data, { ...range, timezone: 'America/Los_Angeles' }).length, 0);
  assert.equal(parseDotUsage(data, { ...range, since: '2026-10-11', until: '2026-10-11', timezone: 'America/Los_Angeles' })[0].input, 20);
});
test('workspace and heatmap retain estimates without duplicating reasoning', () => {
  const workspace = { id: 'work', label: 'Project', directory: '/project' };
  const rows = parseDotUsage(ledger([row]), range, id => id === workspace.id ? workspace : undefined);
  assert.equal(rows[0].workspace?.id, 'work');
  assert.equal(rows[0].reasoning, null);
  const sources = [{ source: 'dot' as const, status: 'ready' as const, updatedAt: null, message: null, rows }];
  assert.equal(totalTokens(groupConsumption(sources, 'workspace')[0]), 10);
  assert.equal(buildMonthHeatmap(sources, '2026-10', '2026-10-12').total, 10);
});
test('reader rejects unsupported or malformed data and resolves only dedicated ledger', () => {
  assert.throws(() => parseDotUsage({ version: 2, entries: [] }, range));
  assert.throws(() => parseDotUsage(ledger([{ ...row, input: -1 }]), range));
  assert.equal(dotUsageFile({ PASEO_HOME: '/paseo' }), '/paseo/paseo-dot-bridge/usage-estimates.json');
  assert.equal(dotUsageFile({ PASEO_DOT_BRIDGE_DATA_DIR: '/bridge' }), '/bridge/usage-estimates.json');
  assert.equal(dotUsageFile({}), null);
});
