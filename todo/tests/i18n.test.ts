import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explain } from '../shared/errors';
import { allStatusLabels } from '../shared/labels';
import { ui } from '../shared/i18n';

describe('todo copy', () => {
  it('explains review and lock failures in both locales', () => {
    assert.match(explain('stale-client-review', null, 'en'), /older review/);
    assert.match(explain('stale-client-review', null, 'zh-CN'), /验收绑定/);
    assert.match(explain('agent-busy', null, 'zh-CN'), /权限/);
    assert.match(explain('store-locked', null, 'en'), /data directory/);
    assert.equal(allStatusLabels().awaiting_review[1], '待验收');
    assert.equal(ui('Tasks', '待办任务', { __PASEO_LOCALE__: 'zh-CN' }), '待办任务');
    assert.equal(ui('Tasks', '待办任务', { __PASEO_LOCALE__: 'en' }), 'Tasks');
  });
});
