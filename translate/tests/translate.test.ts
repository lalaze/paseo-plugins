import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTranslationPrompt, parseTranslationOutput, resolveTarget, translateSelection } from '../server/translate';
import { validateTranslationSettings } from '../shared/settings';

const settings = { apiUrl: 'https://translate.example/v1/chat/completions', apiKey: 'secret-key', model: 'translate-model', fallbackApiUrl: '', fallbackApiKey: '', fallbackModel: '', englishLockModels: 'claude, anthropic' };

test('auto direction follows the dominant script', () => {
  assert.equal(resolveTarget('你好世界，world', 'auto'), 'en');
  assert.equal(resolveTarget('hello world', 'auto'), 'zh-CN');
  assert.equal(resolveTarget('Please review the 翻译 plugin before merging', 'auto'), 'zh-CN');
  assert.equal(resolveTarget('翻译 hello', 'auto'), 'en');
  assert.equal(resolveTarget('翻译 hello world', 'auto'), 'en');
  assert.equal(resolveTarget('翻译 hello world again', 'auto'), 'zh-CN');
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

const fallbackSettings = { ...settings, fallbackApiUrl: 'https://backup.example/v1/chat/completions', fallbackApiKey: 'backup-key', fallbackModel: 'backup-model' };

test('retries the fallback endpoint when the primary fails', async () => {
  const calls: { url: string; authorization: string | undefined; model: string }[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: (init?.headers as Record<string, string>).authorization, model: JSON.parse(String(init?.body)).model });
    if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"translation":"你好","detectedLanguage":"English","note":null}' } }] }), { status: 200 });
  };
  const result = await translateSelection({ text: 'hello', target: 'auto', settings: fallbackSettings }, fetchStub);
  assert.equal(result.translation, '你好');
  assert.equal(result.model, 'backup-model');
  assert.deepEqual(calls, [
    { url: settings.apiUrl, authorization: 'Bearer secret-key', model: 'translate-model' },
    { url: fallbackSettings.fallbackApiUrl, authorization: 'Bearer backup-key', model: 'backup-model' },
  ]);
});

test('combines both errors when primary and fallback fail', async () => {
  const fetchStub: typeof fetch = async (input) => String(input) === settings.apiUrl
    ? new Response(JSON.stringify({ error: { message: 'primary down' } }), { status: 500 })
    : new Response(JSON.stringify({ error: { message: 'fallback down' } }), { status: 503 });
  await assert.rejects(translateSelection({ text: 'hello', target: 'zh-CN', settings: fallbackSettings }, fetchStub), /primary and fallback.*primary down.*fallback down/s);
});

test('does not call a fallback when none is configured', async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 }); };
  await assert.rejects(translateSelection({ text: 'hello', target: 'zh-CN', settings }, fetchStub), /500.*down/);
  assert.equal(calls, 1);
});

test('requires a complete fallback configuration when partially filled', () => {
  assert.throws(() => validateTranslationSettings({ ...settings, fallbackApiUrl: 'https://backup.example/v1/chat/completions' }), /fallback model/);
  assert.throws(() => validateTranslationSettings({ ...settings, fallbackModel: 'backup-model' }), /fallback API URL/);
  assert.throws(() => validateTranslationSettings({ ...fallbackSettings, fallbackApiUrl: 'file:///tmp/backup' }), /HTTP/);
  assert.equal(validateTranslationSettings({ ...settings, fallbackApiUrl: '', fallbackModel: '' }).fallbackModel, '');
});
