import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTranslationPrompt, parseTranslationOutput, resolveTarget, translateSelection } from '../server/translate';
import { validateTranslationSettings } from '../shared/settings';

const settings = { apiUrl: 'https://translate.example/v1/chat/completions', apiKey: 'secret-key', model: 'translate-model' };

test('auto direction sends CJK text to English and other text to Chinese', () => {
  assert.equal(resolveTarget('你好，world', 'auto'), 'en');
  assert.equal(resolveTarget('hello world', 'auto'), 'zh-CN');
  assert.equal(resolveTarget('hello', 'ja'), 'ja');
});

test('accepts keyless local APIs and rejects non-HTTP endpoints', () => {
  assert.equal(validateTranslationSettings({ ...settings, apiKey: '' }).apiKey, '');
  assert.throws(() => validateTranslationSettings({ ...settings, apiUrl: 'file:///tmp/translate' }), /HTTP/);
});

test('parses JSON, fenced JSON, and plain translation output', () => {
  assert.deepEqual(parseTranslationOutput('{"translation":"你好","detectedLanguage":"English","note":null}'), { translation: '你好', detectedLanguage: 'English', note: null });
  assert.equal(parseTranslationOutput('```json\n{"translation":"Bonjour","detectedLanguage":"English","note":"formal"}\n```').translation, 'Bonjour');
  assert.equal(parseTranslationOutput('纯文本结果').translation, '纯文本结果');
});

test('uses a minimal user-only prompt compatible with translation and chat models', () => {
  assert.equal(buildTranslationPrompt('predict', 'zh-CN'), 'Translate the following segment into Simplified Chinese, without additional explanation.\n\npredict');
});

test('calls the configured OpenAI-compatible API without creating a Paseo agent', async () => {
  let requestUrl = '', request: RequestInit | undefined;
  const fetchStub: typeof fetch = async (input, init) => {
    requestUrl = String(input); request = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translation":"你好","detectedLanguage":"English","note":null}' } }] }), { status: 200 });
  };
  const result = await translateSelection({ text: 'hello', target: 'auto', settings }, fetchStub);
  assert.equal(result.translation, '你好');
  assert.equal(result.model, 'translate-model');
  assert.equal(requestUrl, settings.apiUrl);
  assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer secret-key');
  const body = JSON.parse(String(request?.body));
  assert.equal(body.model, 'translate-model');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Translate the following segment into Simplified Chinese, without additional explanation.\n\nhello' }]);
});

test('surfaces a bounded API error message', async () => {
  const fetchStub: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'bad credentials' } }), { status: 401 });
  await assert.rejects(translateSelection({ text: 'hello', target: 'zh-CN', settings }, fetchStub), /401.*bad credentials/);
});
