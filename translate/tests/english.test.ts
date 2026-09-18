import assert from 'node:assert/strict';
import test from 'node:test';
import { isEnglishCompatibleDraft } from '../client/english';

test('strict English mode allows English and language-neutral draft content', () => {
  assert.equal(isEnglishCompatibleDraft('Please review https://example.com/a?q=1 🙂'), true);
  assert.equal(isEnglishCompatibleDraft('const answer = 42;'), true);
  assert.equal(isEnglishCompatibleDraft('123 /help'), true);
});

test('strict English mode rejects non-Latin and mixed-script drafts', () => {
  assert.equal(isEnglishCompatibleDraft('请帮我检查代码'), false);
  assert.equal(isEnglishCompatibleDraft('Please 检查 this'), false);
  assert.equal(isEnglishCompatibleDraft('Проверь код'), false);
});
