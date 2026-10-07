import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collaborationModeLabel, collaborationStatus, taskCollaborationSchema } from '../shared/collaboration';
import { explain } from '../shared/errors';
import { ui } from '../shared/i18n';
import { allStatusLabels } from '../shared/labels';

describe('todo copy', () => {
  it('explains review and lock failures in both locales', () => {
    assert.match(explain('stale-client-review', null, 'en'), /older review/);
    assert.match(explain('stale-client-review', null, 'zh-CN'), /验收绑定/);
    assert.match(explain('agent-busy', null, 'zh-CN'), /权限/);
    assert.match(explain('store-locked', null, 'en'), /data directory/);
    assert.equal(allStatusLabels().awaiting_review[1], '待验收');
    assert.equal(ui('Tasks', '待办任务', { __PASEO_LOCALE__: 'zh-CN' }), '待办任务');
    assert.equal(ui('Tasks', '待办任务', { __PASEO_LOCALE__: 'en' }), 'Tasks');
    const [modeEn, modeZh] = collaborationModeLabel('execute_review');
    assert.equal(ui(modeEn, modeZh, { __PASEO_LOCALE__: 'en' }), modeEn);
    assert.equal(ui(modeEn, modeZh, { __PASEO_LOCALE__: 'zh-CN' }), modeZh);
    const saved = taskCollaborationSchema.parse({
      mode: 'full',
      settings: {
        profiles: [{ id: 'worker', label: 'Work', provider: 'stub/work', transport: 'mcp' }],
        directorProfileId: 'worker',
        workerProfileId: 'worker',
      },
    });
    const status = collaborationStatus({
      collaboration: saved,
      collaborationPhase: 'executing',
      collaborationControl: 'running',
      collaborationAcceptance: null,
    });
    assert.ok(status);
    assert.equal(ui(status.title[0], status.title[1], { __PASEO_LOCALE__: 'zh-CN' }), status.title[1]);
    assert.equal(ui(status.title[0], status.title[1], { __PASEO_LOCALE__: 'en' }), status.title[0]);
  });
});
