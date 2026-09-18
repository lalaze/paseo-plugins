import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUiLocale } from '../shared/i18n';

test('follows the explicit Paseo or system language', () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: 'zh-CN' }) },
    navigator: { languages: ['en-US'] },
  }), 'zh-CN');
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: 'system' }) },
    navigator: { languages: ['en-US'] },
  }), 'en');
});
