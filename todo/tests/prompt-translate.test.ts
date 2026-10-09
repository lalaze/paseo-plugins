import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptAfterTranslation, promptTranslateClick, TASK_TRANSLATION_LIMIT } from '../client/prompt-translate';
import { translationBridge } from '../client/translate-bridge';

describe('task prompt translation', () => {
  it('translates a draft and undoes an unchanged result', () => {
    const first = promptTranslateClick({ prompt: '  修好登录  ', undo: null, busy: false });
    assert.deepEqual(first, { kind: 'translate', text: '修好登录', original: '  修好登录  ' });
    const applied = promptAfterTranslation('  修好登录  ', '  修好登录  ', 'Fix the login');
    assert.deepEqual(applied, { prompt: 'Fix the login', undo: { before: '  修好登录  ', after: 'Fix the login' } });
    assert.deepEqual(promptTranslateClick({ prompt: 'Fix the login', undo: applied!.undo, busy: false }), { kind: 'undo', prompt: '  修好登录  ' });
  });

  it('leaves a task that changed while translating', () => {
    assert.equal(promptAfterTranslation('修好登录，顺便加测试', '修好登录', 'Fix the login'), null);
  });

  it('ignores a click while a translation is running', () => {
    assert.equal(promptTranslateClick({ prompt: '修好登录', undo: null, busy: true }), null);
  });

  it('rejects an empty task and one past the translation limit', () => {
    assert.equal(promptTranslateClick({ prompt: '  \n ', undo: null, busy: false })?.kind, 'reject');
    const over = promptTranslateClick({ prompt: 'a'.repeat(TASK_TRANSLATION_LIMIT + 1), undo: null, busy: false });
    assert.equal(over?.kind, 'reject');
    assert.match(over && over.kind === 'reject' ? over.message : '', /5,000|5000/);
  });

  it('reads the translate plugin bridge only when it is open and complete', () => {
    const key = Symbol.for('lalaze.paseo-translate.registry.v1');
    const holder = globalThis as { [key]?: unknown };
    const previous = holder[key];
    try {
      delete holder[key];
      assert.equal(translationBridge(), null);
      holder[key] = { closed: true, available: () => true, translate: () => null, subscribe: () => () => {} };
      assert.equal(translationBridge(), null);
      holder[key] = { closed: false, available: () => false };
      assert.equal(translationBridge(), null);
      const bridge = { closed: false, available: (id: string) => id === 'srv', translate: () => null, subscribe: () => () => {} };
      holder[key] = bridge;
      assert.equal(translationBridge(), bridge);
    } finally {
      if (previous === undefined) delete holder[key];
      else holder[key] = previous;
    }
  });
});
