import assert from 'node:assert/strict';
import test from 'node:test';
import { isEnglishCompatibleDraft, matchesEnglishLockModel, normalizeComposerModelLabel, parseEnglishLockModels } from '../client/english';

test('strict English mode allows English and language-neutral draft content', () => {
  assert.equal(isEnglishCompatibleDraft('Please review https://example.com/a?q=1 🙂'), true);
  assert.equal(isEnglishCompatibleDraft('const answer = 42;'), true);
  assert.equal(isEnglishCompatibleDraft('123 /help'), true);
});

test('strict English mode rejects non-Latin and mostly non-English drafts', () => {
  assert.equal(isEnglishCompatibleDraft('请帮我检查代码'), false);
  assert.equal(isEnglishCompatibleDraft('Проверь код'), false);
  assert.equal(isEnglishCompatibleDraft('帮我看看 this function 为什么报错'), false);
  assert.equal(isEnglishCompatibleDraft('请帮我 review 一下 this PR 的 test coverage'), false);
  assert.equal(isEnglishCompatibleDraft('Please fix the bug 并且把结果写到文档里然后通知我'), false);
  assert.equal(isEnglishCompatibleDraft('"请帮我检查代码"'), false);
  assert.equal(isEnglishCompatibleDraft('```\n// 注释\n```'), false);
});

test('strict English mode allows names and short terms inside English drafts', () => {
  assert.equal(isEnglishCompatibleDraft('Please ask 张三 to review the PR'), true);
  assert.equal(isEnglishCompatibleDraft('Ask 张三 and 李四 to review it'), true);
  assert.equal(isEnglishCompatibleDraft('Book a table at 東京タワー tonight please'), true);
  assert.equal(isEnglishCompatibleDraft('Compare Tolstoy with Достоевский and Chekhov in one short essay'), true);
  assert.equal(isEnglishCompatibleDraft('Summarize 《三体》 in English'), true);
});

test('strict English mode allows verbatim quoted and coded non-English literals', () => {
  assert.equal(isEnglishCompatibleDraft('Translate "请帮我把这段代码重构一下并补充测试" into English'), true);
  assert.equal(isEnglishCompatibleDraft('Rename the `验收通过并归档所有相关任务` command'), true);
  assert.equal(isEnglishCompatibleDraft('Explain this:\n```ts\n// 计算用户的剩余额度并返回\nconst quota = 1;\n```'), true);
  const prompt = [
    'Tell the main Agent not to restate the card or narrate the "后台/调度" machinery. After a notice, it replies only with what the user needs: what changed, what is next, and what (if anything) the user must do.',
    '3. Acceptance step: when the AI review passes and the task awaits user acceptance, the main Agent gives one structured summary (actual changes, verification run and results, known limitations), followed by the exact next actions: reply 验收通过 alone to accept, 不采纳成果 alone to reject, or describe changes to request rework.',
    '- Keep i18n: update both English and zh-CN resources for any new or changed strings.',
  ].join('\n');
  assert.equal(isEnglishCompatibleDraft(prompt), true);
});

test('configurable model keywords match provider and model descriptors', () => {
  const keywords = parseEnglishLockModels(' Claude, anthropic；sonnet 4\nCLAUDE ');
  assert.deepEqual(keywords, ['claude', 'anthropic', 'sonnet 4']);
  assert.equal(matchesEnglishLockModel('anthropic/claude-sonnet-4-5', keywords), true);
  assert.equal(matchesEnglishLockModel('custom/Sonnet 4 tuned', keywords), true);
  assert.equal(matchesEnglishLockModel('openai/gpt-5', keywords), false);
  assert.equal(matchesEnglishLockModel('anthropic/claude', []), false);
});

test('normalizes short Claude model labels shown by the composer', () => {
  assert.equal(normalizeComposerModelLabel('  Opus  5  '), 'claude/Opus 5');
  assert.equal(normalizeComposerModelLabel('Sonnet 4.6'), 'claude/Sonnet 4.6');
  assert.equal(normalizeComposerModelLabel('Fable 5 1M'), 'claude/Fable 5 1M');
  assert.equal(normalizeComposerModelLabel('Mythos 5.1'), 'claude/Mythos 5.1');
  assert.equal(normalizeComposerModelLabel('GPT-5.6'), 'GPT-5.6');
  assert.equal(normalizeComposerModelLabel('  '), null);
});
