import assert from 'node:assert/strict';
import test from 'node:test';
import { isEnglishCompatibleDraft, matchesEnglishLockModel, parseEnglishLockModels } from '../client/english';

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

test('configurable model keywords match provider and model descriptors', () => {
  const keywords = parseEnglishLockModels(' Claude, anthropic；sonnet 4\nCLAUDE ');
  assert.deepEqual(keywords, ['claude', 'anthropic', 'sonnet 4']);
  assert.equal(matchesEnglishLockModel('anthropic/claude-sonnet-4-5', keywords), true);
  assert.equal(matchesEnglishLockModel('custom/Sonnet 4 tuned', keywords), true);
  assert.equal(matchesEnglishLockModel('openai/gpt-5', keywords), false);
  assert.equal(matchesEnglishLockModel('anthropic/claude', []), false);
});
