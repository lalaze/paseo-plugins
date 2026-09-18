import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUiLocale } from '../client/i18n';

test('uses the explicit Paseo language before the browser locale', () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: 'zh-CN' }) },
    navigator: { languages: ['en-US'] },
  }), 'zh-CN');
});

test('follows the system locale when Paseo is set to system', () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: 'system' }) },
    navigator: { languages: ['zh-Hans-US', 'en-US'] },
  }), 'zh-CN');
});

test('falls back to English for unsupported and malformed settings', () => {
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => '{broken' },
    navigator: { languages: ['de-DE'] },
  }), 'en');
  assert.equal(resolveUiLocale({
    localStorage: { getItem: () => JSON.stringify({ language: 'ja' }) },
    navigator: { languages: ['zh-CN'] },
  }), 'en');
});
