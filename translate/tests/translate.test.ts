import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranslationOutput, resolveTarget, translateSelection } from '../server/translate';

test('auto direction sends CJK text to English and other text to Chinese', () => {
  assert.equal(resolveTarget('你好，world', 'auto'), 'en');
  assert.equal(resolveTarget('hello world', 'auto'), 'zh-CN');
  assert.equal(resolveTarget('hello', 'ja'), 'ja');
});

test('parses JSON, fenced JSON, and plain translation output', () => {
  assert.deepEqual(parseTranslationOutput('{"translation":"你好","detectedLanguage":"English","note":null}'), { translation: '你好', detectedLanguage: 'English', note: null });
  assert.equal(parseTranslationOutput('```json\n{"translation":"Bonjour","detectedLanguage":"English","note":"formal"}\n```').translation, 'Bonjour');
  assert.equal(parseTranslationOutput('纯文本结果').translation, '纯文本结果');
});

test('uses the current agent model in an internal auto-archived session', async () => {
  let createInput: any, archived = 0;
  const paseo: any = {
    agents: {
      ref: () => ({ refresh: async () => ({ agent: { id: 'a1', provider: 'codex', model: 'gpt-test', cwd: '/repo', status: 'idle', archivedAt: null } }) }),
      create: async (input: unknown) => {
        createInput = input;
        return { waitForFinish: async () => ({ status: 'idle', final: null, error: null, lastMessage: '{"translation":"你好","detectedLanguage":"English","note":null}' }), archive: async () => { archived++; } };
      },
    },
    providers: { waitForReady: async () => { throw new Error('should not discover'); } },
  };
  const result = await translateSelection({ text: 'hello', target: 'auto', agentId: 'a1' }, paseo);
  assert.equal(result.translation, '你好');
  assert.equal(result.model, 'codex/gpt-test');
  assert.equal(createInput.cwd, '/repo');
  assert.equal(createInput.autoArchive, true);
  assert.equal(createInput.config.internal, true);
  assert.equal(archived, 1);
});
